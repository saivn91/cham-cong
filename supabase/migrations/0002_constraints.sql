-- Migration: 0002_constraints.sql
-- Mô tả: Extensions, ràng buộc GiST chống trùng lịch, CHECK nghiệp vụ và các Index hiệu năng cao

-- 1. Extensions bắt buộc (pgcrypto cho băm PIN/mã, btree_gist cho ràng buộc chống chồng lấn thời gian)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Ràng buộc toàn vẹn dữ liệu (Constraints)
-- Mã nhân viên bắt buộc là chuỗi số 4–6 chữ số và không bắt đầu bằng chữ số 0 (1000..999999)
ALTER TABLE public.employees
    ADD CONSTRAINT employees_employee_code_numeric_chk
    CHECK (employee_code ~ '^[1-9][0-9]{3,5}$');

-- Chống phân ca trùng lặp thời gian cho cùng một nhân viên (bỏ qua ca đã bị từ chối)
ALTER TABLE public.shifts
    ADD CONSTRAINT shifts_employee_during_overlap_excl
    EXCLUDE USING gist (employee_id WITH =, during WITH &&)
    WHERE (status <> 'rejected');

-- Giới hạn độ dài tối đa của một ca làm việc không vượt quá 12 tiếng
ALTER TABLE public.shifts
    ADD CONSTRAINT shifts_max_12_hours_chk
    CHECK (upper(during) - lower(during) <= interval '12 hours');

-- Chấm công thủ công bắt buộc lưu người tạo và lý do để phục vụ hậu kiểm
ALTER TABLE public.punches
    ADD CONSTRAINT punches_manual_source_audit_chk
    CHECK (source = 'kiosk' OR (created_by IS NOT NULL AND reason IS NOT NULL));

-- 3. Indexes tối ưu truy vấn theo thời gian, chi nhánh và kỳ lương
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
CREATE INDEX IF NOT EXISTS idx_employees_home_branch_id
    ON public.employees USING btree (home_branch_id);

CREATE INDEX IF NOT EXISTS idx_devices_branch_id
    ON public.devices USING btree (branch_id);

CREATE INDEX IF NOT EXISTS idx_monthly_allowances_period_employee
    ON public.monthly_allowances USING btree (period_id, employee_id);
