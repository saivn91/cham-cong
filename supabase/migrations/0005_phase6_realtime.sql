-- Migration: 0005_phase6_realtime.sql
-- Description: Đảm bảo bảng public.shifts và public.punches có trong publication supabase_realtime.

DO $$
BEGIN
    -- Kiểm tra publication supabase_realtime tồn tại
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        RAISE EXCEPTION 'Publication supabase_realtime does not exist';
    END IF;

    -- Thêm public.shifts nếu chưa có trong publication
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'shifts'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.shifts;
    END IF;

    -- Thêm public.punches nếu chưa có trong publication
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'punches'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.punches;
    END IF;
END
$$;
