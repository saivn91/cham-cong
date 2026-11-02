-- supabase/seed.sql
-- Development Seed Data

-- 1. Branches
INSERT INTO public.branches (id, code, name, address)
VALUES
    ('b0000000-0000-0000-0000-000000000001', 'CN001', 'Chi nhánh Quận 1 (TP.HCM)', 'Số 123 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh'),
    ('b0000000-0000-0000-0000-000000000002', 'CN002', 'Chi nhánh Cầu Giấy (Hà Nội)', 'Số 456 Cầu Giấy, Phường Dịch Vọng, Quận Cầu Giấy, Hà Nội')
ON CONFLICT (code) DO NOTHING;

-- 2. Shift Templates
INSERT INTO public.shift_templates (branch_id, name, start_time, end_time)
VALUES
    ('b0000000-0000-0000-0000-000000000001', 'Ca sáng (08:00 - 16:00)', '08:00:00', '16:00:00'),
    ('b0000000-0000-0000-0000-000000000001', 'Ca chiều (16:00 - 00:00)', '16:00:00', '00:00:00'),
    ('b0000000-0000-0000-0000-000000000001', 'Ca đêm (00:00 - 08:00)', '00:00:00', '08:00:00'),
    ('b0000000-0000-0000-0000-000000000002', 'Ca sáng (08:00 - 16:00)', '08:00:00', '16:00:00'),
    ('b0000000-0000-0000-0000-000000000002', 'Ca chiều (16:00 - 00:00)', '16:00:00', '00:00:00'),
    ('b0000000-0000-0000-0000-000000000002', 'Ca đêm (00:00 - 08:00)', '00:00:00', '08:00:00')
ON CONFLICT DO NOTHING;

-- 3. Holidays (Việt Nam 2026/2027)
INSERT INTO public.holidays (date, name, rate)
VALUES
    ('2026-01-01', 'Tết Dương Lịch 2026', 2.0),
    ('2026-02-16', 'Tết Nguyên Đán (29 Tết)', 2.0),
    ('2026-02-17', 'Tết Nguyên Đán (Mùng 1)', 2.0),
    ('2026-02-18', 'Tết Nguyên Đán (Mùng 2)', 2.0),
    ('2026-02-19', 'Tết Nguyên Đán (Mùng 3)', 2.0),
    ('2026-04-26', 'Giỗ Tổ Hùng Vương (10/3 Âm lịch)', 2.0),
    ('2026-04-30', 'Ngày Giải phóng miền Nam', 2.0),
    ('2026-05-01', 'Ngày Quốc tế Lao động', 2.0),
    ('2026-09-02', 'Quốc khánh nước CHXHCN Việt Nam', 2.0)
ON CONFLICT (date) DO NOTHING;

-- 4. Initial Open Payroll Period (Kỳ hiện tại)
INSERT INTO public.payroll_periods (year, month, status)
VALUES
    (EXTRACT(YEAR FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM CURRENT_DATE)::int, 'open')
ON CONFLICT (year, month) DO NOTHING;
