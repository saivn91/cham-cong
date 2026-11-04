# Hướng dẫn Dựng Môi trường Test Local (Windows PowerShell)

Tài liệu này hướng dẫn từng bước cách thiết lập, cấu hình, khởi chạy và kiểm thử hệ thống `timekeeping-monorepo` trên môi trường **LOCAL** dành cho người mới sử dụng **Windows PowerShell** (mục tiêu tài liệu: `docs/local-test-environment.md`).

---

## 1. Tổng quan Kiến trúc & Danh sách Cổng (Ports) Local

Khi chạy đầy đủ ở môi trường local, hệ thống bao gồm các thành phần sau:

| Thành phần | Công nghệ / Công cụ | Cổng (Port) | Địa chỉ truy cập Local | Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| **Web App (Dev)** | Vite + React 19 | `5173` | `http://localhost:5173` | Giao diện người dùng chính (`@timekeeping/web`) |
| **Worker API (Dev)** | Cloudflare Wrangler + Hono | `8787` | `http://localhost:8787` | API quản trị & thiết bị (`@timekeeping/worker`) |
| **Supabase API** | Kong / PostgREST / GoTrue | `54321` | `http://127.0.0.1:54321` | Endpoint REST, Auth, Storage, Realtime local |
| **Supabase DB** | PostgreSQL 17 | `54322` | `127.0.0.1:54322` | Cơ sở dữ liệu Postgres local (Shadow DB port: `54320`) |
| **Supabase Studio** | Supabase Dashboard Local | `54323` | `http://127.0.0.1:54323` | Giao diện quản lý bảng, RLS, RPC và SQL Editor |
| **Mailpit (Local SMTP)** | Local SMTP test server (`[local_smtp]`) | `54324` | `http://127.0.0.1:54324` | Web UI hộp thư thử nghiệm bắt email từ Supabase Auth local (SMTP port: `54325`) |
| **Web Preview / E2E** | Vite + Playwright | `4173` | `http://127.0.0.1:4173` | Tự động bật khi chạy bộ kiểm thử smoke E2E |

---

## 2. Yêu cầu Tiên quyết (Prerequisites)

Trước khi bắt đầu, hãy mở **Windows PowerShell** và đảm bảo máy của bạn đáp ứng các điều kiện sau:

1. **Node.js**: Phiên bản `>= 22.12.0` (theo cấu hình `engines` trong `package.json`).
2. **pnpm**: Phiên bản `9.15.4` (hoặc `>= 9.0.0`).
3. **Docker Desktop for Windows**: **Bắt buộc phải cài đặt và đang chạy** để khởi tạo các container của Supabase local.

### Kiểm tra nhanh công cụ trên PowerShell

```powershell
# Kiểm tra phiên bản Node.js và pnpm
node -v
pnpm -v
```

Nếu chưa bật `pnpm` hoặc cần đồng bộ đúng phiên bản `pnpm@9.15.4` khai báo trong repo, bạn có thể kích hoạt qua Corepack:

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

### Kiểm tra Docker Desktop

Hãy mở ứng dụng **Docker Desktop** trên Windows, đợi biểu tượng Docker ở khay hệ thống báo trạng thái **Engine running**, sau đó chạy lệnh sau trên PowerShell:

```powershell
docker info
```

> **Lưu ý quan trọng**: Nếu lệnh `docker info` báo lỗi kết nối hoặc lỗi quyền truy cập ống dẫn (`permission denied` trên `//./pipe/dockerDesktopLinuxEngine`), Supabase local sẽ **không thể khởi chạy**. Xem mục [Xử lý lỗi phổ biến](#10-xử-lý-lỗi-phổ-biến-troubleshooting) ở cuối tài liệu để khắc phục trước khi đi tiếp.

---

## 3. Bước 1: Cài đặt Dependencies

Mở **Terminal 1 (PowerShell)**, di chuyển vào thư mục gốc của repository và cài đặt toàn bộ gói phụ thuộc cho các workspace (`apps/web`, `apps/worker`, `packages/shared`):

```powershell
# Di chuyển tới thư mục gốc của repo (thay đổi đường dẫn cho đúng với máy của bạn)
Set-Location -Path <đường-dẫn-tới-repo>

# Cài đặt toàn bộ dependencies
pnpm install
```

> **Mẹo**: Supabase CLI (`^3.0.0`) đã được khai báo sẵn trong `devDependencies` ở `package.json` gốc. Bạn có thể gọi CLI chuẩn trực tiếp từ thư mục gốc thông qua `pnpm exec supabase <lệnh>` mà không bắt buộc phải cài đặt toàn cục (global).

---

## 4. Bước 2: Khởi chạy Supabase Local, Migrations & Seed Data

### 4.1. Khởi chạy stack Supabase local

Tại **Terminal 1** (đang ở thư mục gốc của repo), chạy lệnh:

```powershell
pnpm exec supabase start
```

Lần chạy đầu tiên sẽ mất vài phút để Docker tải các image (PostgreSQL 17, GoTrue, PostgREST, Studio, Mailpit...). Khi khởi chạy thành công, CLI sẽ hiển thị bảng thông tin kết nối gồm `API URL`, `DB URL`, `Studio URL`, `anon key`, và `service_role key`.

Bạn có thể xem lại các thông số này bất kỳ lúc nào bằng lệnh:

```powershell
pnpm exec supabase status
```

> **Lưu ý khi cập nhật `supabase/config.toml` (Supabase CLI 3.0.0)**: Cấu hình local sử dụng phân đoạn `[local_smtp]` (Mailpit Web UI tại cổng `54324`, cổng SMTP tại `54325`) thay cho `[inbucket]` đã ngừng hỗ trợ trên Supabase CLI v3. Sau khi thay đổi `supabase/config.toml`, cần khởi động lại local stack bằng cách chạy `pnpm exec supabase stop` rồi chạy lại `pnpm exec supabase start`. **Không** chạy `pnpm exec supabase db reset` để xử lý lỗi cấu hình — việc dừng và bật lại bằng `supabase stop` rồi `supabase start` sẽ áp dụng cấu hình mới và **dữ liệu DB local được giữ lại**.

### 4.2. Kiểm tra các bản ghi Migration được áp dụng

Khi khởi tạo container DB local, Supabase áp dụng theo thứ tự các tệp trong `supabase/migrations/`:

1. `0001_tables.sql` — Khởi tạo 14 bảng dữ liệu cốt lõi.
2. `0002_constraints.sql` — Các ràng buộc toàn vẹn dữ liệu.
3. `0003_rls.sql` — Chính sách bảo mật Row Level Security (RLS).
4. `0004_functions.sql` — Các hàm RPC xử lý nghiệp vụ.
5. `0005_phase6_realtime.sql` — Cấu hình publication cho Realtime.

### 4.3. Kiểm tra và nạp dữ liệu mẫu (`supabase/seed.sql`)

Tệp `supabase/config.toml` hiện tại không khai báo tường minh phân đoạn `[db.seed]`. Do đó, tùy thuộc hành vi của phiên bản CLI trên môi trường của bạn, tệp `supabase/seed.sql` có thể chưa được thực thi tự động sau khi `start`.

Hãy kiểm tra và nạp seed một cách minh bạch như sau:

1. Mở **Supabase Studio** trên trình duyệt tại: `http://127.0.0.1:54323`
2. Vào mục **Table Editor** -> chọn bảng `branches`.
3. Nếu đã thấy 2 chi nhánh mẫu (`CN001` và `CN002`), dữ liệu seed đã được nạp.
4. Nếu bảng `branches` đang trống, bạn có thể nạp `supabase/seed.sql` vào **database local** bằng một trong hai cách sau:

**Cách A — Chạy qua SQL Editor trên Supabase Studio (Khuyên dùng cho người mới):**
1. Mở `http://127.0.0.1:54323` -> chọn mục **SQL Editor** ở thanh bên trái.
2. Mở tệp `supabase/seed.sql` trên máy, sao chép toàn bộ nội dung dán vào khung soạn thảo SQL và nhấn **Run**.

**Cách B — Chạy trực tiếp từ PowerShell vào container Postgres local:**
```powershell
Get-Content -Path .\supabase\seed.sql -Raw | docker exec -i supabase_db_timekeeping psql -U postgres -d postgres
```
*(Nếu tên container DB trên máy bạn khác `supabase_db_timekeeping`, hãy chạy `docker ps` để xem tên chính xác của container Postgres).*

> **Lưu ý an toàn**: Tệp `supabase/seed.sql` sử dụng mệnh đề `ON CONFLICT ... DO NOTHING` nên an toàn khi chạy lại trên môi trường local. Tuy nhiên, **tuyệt đối không** chạy dữ liệu seed thử nghiệm này lên cơ sở dữ liệu Production.

### 4.4. Phạm vi của `supabase/seed.sql` (Quan trọng)

Tệp `supabase/seed.sql` **CHỈ** khởi tạo dữ liệu danh mục nền tảng gồm:
- **2 chi nhánh mẫu (`public.branches`)**:
  - `CN001`: Chi nhánh Quận 1 (TP.HCM) (`b0000000-0000-0000-0000-000000000001`)
  - `CN002`: Chi nhánh Cầu Giấy (Hà Nội) (`b0000000-0000-0000-0000-000000000002`)
- **3 mẫu ca làm việc dùng chung (`public.shift_templates`)**: Ca sáng, Ca chiều, Ca đêm; không có `branch_id`.
- **Danh sách ngày nghỉ lễ (`public.holidays`)**: Các ngày lễ Việt Nam năm 2026.
- **Kỳ lương mở ban đầu (`public.payroll_periods`)**: Kỳ lương của tháng/năm hiện tại với trạng thái `open`.

> **CẢNH BÁO QUAN TRỌNG**: `supabase/seed.sql` **KHÔNG** tạo sẵn bất kỳ tài khoản người dùng nào trong `auth.users`, **KHÔNG** tạo hồ sơ trong `public.employees`, và **KHÔNG** tạo sẵn tài khoản Admin, Manager, Employee hay Kiosk mặc định. Xem hướng dẫn chi tiết về tài khoản kiểm thử tại [Mục 7.3](#73-phân-biệt-kiểm-thử-smoke-ui-và-kiểm-thử-nghiệp-vụ-cần-tài-khoản).

---

## 5. Bước 3: Cấu hình Biến Môi trường Local (Web & Worker)

> **Lưu ý về tệp mẫu**: Repository hiện **không** có sẵn tệp `apps/web/.env.example` hay `apps/worker/.dev.vars.example`. Không sử dụng lệnh `Copy-Item` từ tệp `.example`; thay vào đó hãy tạo mới trực tiếp hai tệp cấu hình local theo hướng dẫn dưới đây. Cả hai tệp này đều đã được khai báo trong `.gitignore` để tránh vô tình commit khóa bí mật lên Git.

Trước tiên, tại **Terminal 1**, hãy chạy lệnh sau để lấy khóa kết nối local từ Supabase CLI:

```powershell
pnpm exec supabase status
```

Ghi nhận 3 giá trị từ màn hình kết quả:
- `API URL` (mặc định là `http://127.0.0.1:54321`)
- `anon key`
- `service_role key`

### 5.1. Tạo tệp `apps/web/.env.local` cho ứng dụng Web

Ứng dụng Web bắt buộc phải khai báo đủ 3 biến môi trường trong `apps/web/.env.local`:
- `VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY`: Khởi tạo kết nối Supabase (`apps/web/src/lib/supabase.ts`).
- `VITE_WORKER_URL`: Địa chỉ Cloudflare Worker API local (`http://localhost:8787`) để `apiFetch` (`apps/web/src/lib/api.ts`) gọi tới Worker thay vì gửi nhầm vào origin của Vite (`http://localhost:5173`).

> **Nguyên tắc bảo mật**: Chỉ sử dụng `anon key` cho ứng dụng Web. **Tuyệt đối KHÔNG** đặt `service_role key` vào `apps/web/.env.local` hoặc bất kỳ biến môi trường nào có tiền tố `VITE_`, vì Vite sẽ nhúng các biến này vào mã nguồn phía trình duyệt.

Chạy khối lệnh PowerShell sau tại thư mục gốc để tạo tệp `apps/web/.env.local` chuẩn **UTF-8 không BOM** (tránh lỗi ký tự BOM ở đầu tệp làm Vite bỏ qua biến đầu tiên trên Windows PowerShell 5.1), sau đó thay `<DÁN_ANON_KEY_LOCAL_CỦA_BẠN_VÀO_ĐÂY>` bằng giá trị `anon key` in ra từ `pnpm exec supabase status`:

```powershell
$webEnv = @'
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<DÁN_ANON_KEY_LOCAL_CỦA_BẠN_VÀO_ĐÂY>
VITE_WORKER_URL=http://localhost:8787
'@
[System.IO.File]::WriteAllText((Join-Path $PWD 'apps\web\.env.local'), "$webEnv`r`n", [System.Text.UTF8Encoding]::new($false))
```

Hoặc bạn có thể mở trực tiếp bằng Notepad để dán giá trị và lưu lại:

```powershell
notepad .\apps\web\.env.local
```

### 5.2. Tạo tệp `apps/worker/.dev.vars` cho Cloudflare Worker

Trong `apps/worker/wrangler.toml`, biến `SUPABASE_URL` đang để giá trị giữ chỗ (`https://your-project-ref.supabase.co`). Khi chạy `wrangler dev` ở local, Wrangler sẽ tự động đọc tệp `apps/worker/.dev.vars` để nạp secrets và ghi đè biến môi trường cho Worker.

Worker (`apps/worker/src/index.ts`) cần các biến sau:
- `SUPABASE_URL`: Địa chỉ Supabase API local (`http://127.0.0.1:54321`).
- `SUPABASE_ANON_KEY`: Dùng cho client kiểm tra JWT và thực thi truy vấn/RPC dưới quyền RLS của người gọi.
- `SUPABASE_SERVICE_ROLE_KEY`: Dùng cho các thao tác quản trị Supabase Auth và kiểm tra quyền hệ thống.
- `ALLOWED_ORIGIN`: Whitelist CORS cho phép Web App gọi API (mặc định trong code là `http://localhost:5173`).

Chạy khối lệnh PowerShell sau tại thư mục gốc để tạo tệp `apps/worker/.dev.vars` (thay 2 giá trị giữ chỗ bằng `anon key` và `service_role key` từ lệnh `pnpm exec supabase status`):

```powershell
@'
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<DÁN_ANON_KEY_LOCAL_CỦA_BẠN_VÀO_ĐÂY>
SUPABASE_SERVICE_ROLE_KEY=<DÁN_SERVICE_ROLE_KEY_LOCAL_CỦA_BẠN_VÀO_ĐÂY>
ALLOWED_ORIGIN=http://localhost:5173
'@ | Set-Content -Path .\apps\worker\.dev.vars -Encoding UTF8
```

Hoặc mở bằng Notepad để chỉnh sửa:

```powershell
notepad .\apps\worker\.dev.vars
```

### 5.3. Truy cập thử nghiệm từ Điện thoại / Thiết bị khác cùng Mạng LAN

Khi mở Web App từ điện thoại trên cùng mạng Wi-Fi/LAN (ví dụ `http://192.168.1.4:5173/`), trình duyệt trên điện thoại không thể gọi `localhost` hay `127.0.0.1` của máy tính chạy server. Các dịch vụ dev (`vite --host 0.0.0.0 --port 5173`, `wrangler dev --ip 0.0.0.0 --port 8787`, và Supabase Kong `0.0.0.0:54321`) đều lắng nghe trên LAN, nhưng bạn cần cập nhật các biến URL/origin local như sau:

- Trong `apps/web/.env.local`:
  - `VITE_SUPABASE_URL=http://192.168.1.4:54321`
  - `VITE_WORKER_URL=http://192.168.1.4:8787`
- Trong `apps/worker/.dev.vars`:
  - `ALLOWED_ORIGIN=http://localhost:5173,http://192.168.1.4:5173` (cho phép cả trình duyệt trên máy tính lẫn điện thoại qua LAN)

> **Lưu ý**:
> - Nếu địa chỉ IPv4 LAN của máy tính thay đổi (do DHCP cấp lại khi kết nối lại Wi-Fi/LAN), bạn cần cập nhật lại IP tương ứng ở các biến trên.
> - Giữ nguyên các khóa bí mật (`VITE_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) tại tệp local và tuyệt đối không commit `.env.local` hay `.dev.vars`.
> - Khởi động lại `pnpm dev:web` và `pnpm dev:worker` sau khi cập nhật.

---

## 6. Bước 4: Khởi chạy Ứng dụng (Web & Cloudflare Worker)

Để dễ theo dõi log và xử lý lỗi trong quá trình phát triển/kiểm thử, khuyến nghị mở thêm **2 cửa sổ PowerShell riêng biệt** (đều đứng tại thư mục gốc của repo):

### Terminal 2 — Chạy Cloudflare Worker (`port 8787`)

```powershell
Set-Location -Path <đường-dẫn-tới-repo>
pnpm dev:worker
```

Khi khởi chạy thành công, Wrangler sẽ lắng nghe tại `http://localhost:8787`.

### Terminal 3 — Chạy Web App Vite (`port 5173`)

```powershell
Set-Location -Path <đường-dẫn-tới-repo>
pnpm dev:web
```

Khi khởi chạy thành công, Vite dev server sẽ lắng nghe tại `http://localhost:5173`.

> **Tùy chọn chạy gộp**: Nếu muốn khởi chạy song song cả Web và Worker trong cùng một cửa sổ terminal, bạn có thể dùng lệnh `pnpm dev` (`pnpm --parallel -r dev`) tại thư mục gốc. Tuy nhiên, việc tách riêng Terminal 2 và Terminal 3 giúp dễ đọc log và khởi động lại từng dịch vụ độc lập khi thay đổi biến môi trường.

---

## 7. Bước 5: Kiểm tra Health & Lưu ý về Tài khoản Kiểm thử

Quay lại **Terminal 1** để thực hiện các bước kiểm tra trạng thái hệ thống khi các dịch vụ đã được bật.

### 7.1. Kiểm tra Health Endpoint của Worker API

Endpoint `GET /api/health` là route công khai duy nhất trên Worker không yêu cầu Bearer token xác thực:

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/api/health" -Method Get
```

Kết quả trả về hợp lệ trên PowerShell sẽ có dạng:

```text
ok   service            timestamp
--   -------            ---------
True timekeeping-worker 2026-...
```

*(Hoặc nếu dùng `curl.exe http://localhost:8787/api/health`, bạn sẽ nhận được chuỗi JSON `{"ok":true,"service":"timekeeping-worker","timestamp":"..."}`).*

### 7.2. Kiểm tra Giao diện Web và Supabase Studio

- Mở trình duyệt truy cập **Web App**: `http://localhost:5173`
- Mở trình duyệt truy cập **Supabase Studio**: `http://127.0.0.1:54323`
- Mở trình duyệt truy cập **Mailpit / Local SMTP (Email test)**: `http://127.0.0.1:54324`

### 7.3. Phân biệt Kiểm thử Smoke UI và Kiểm thử Nghiệp vụ (Cần tài khoản)

Do cơ sở dữ liệu local sau khi chạy migration và `supabase/seed.sql` **không tạo sẵn bất kỳ user hay admin nào**, bạn cần phân biệt rõ hai cấp độ kiểm thử dưới đây:

1. **Kiểm thử Smoke Giao diện & Route Guard (Không cần tài khoản trong DB):**
   - Kiểm tra ứng dụng Web khởi chạy không lỗi cấu hình môi trường.
   - Kiểm tra màn hình đăng nhập và cơ chế chặn điều hướng (route guard) khi người dùng chưa xác thực.
   - Chạy bộ kiểm thử tự động Playwright E2E smoke (xem [Mục 8.3](#83-chạy-bộ-kiểm-thử-smoke-e2e-với-playwright)). Bộ E2E này **chỉ kiểm thử smoke UI và điều hướng phía client**, không kiểm thử tích hợp sâu vào dữ liệu DB hay gọi RPC/Worker với tài khoản thật.

2. **Kiểm thử Luồng Nghiệp vụ Đầy đủ (Đòi hỏi tài khoản Local đã được Provision):**
   - Theo định nghĩa schema tại `supabase/migrations/0001_tables.sql`, bảng `public.employees` chỉ chấp nhận 3 giá trị `role` là `'employee'`, `'manager'`, hoặc `'admin'` (`CHECK (role IN ('employee', 'manager', 'admin'))`), kết hợp với tài khoản trong **Supabase Auth** (`auth.users`) có cùng `id` kiểu UUID:
     - **Quyền Admin (`admin`)**: Cần user trong Supabase Auth đã xác nhận email và có bản ghi tương ứng trong `public.employees` với `role = 'admin'` và `is_active = true`. Mọi endpoint quản trị trên Worker (`POST /api/employees`, `POST /api/employees/:id/reset-password`, `POST /api/devices`, `POST /api/devices/:id/revoke`) đều kiểm tra điều kiện này trước khi thực thi.
     - **Quyền Quản lý (`manager`)**: Có tài khoản Auth và bản ghi `public.employees` với `role = 'manager'`, `is_active = true`, đồng thời được phân quyền chi nhánh trong bảng `public.manager_branches`.
     - **Quyền Nhân viên (`employee`)**: Có tài khoản Auth và bản ghi `public.employees` với `role = 'employee'`, `is_active = true` (được tạo qua API `POST /api/employees` hoặc RPC `admin_create_employee_with_pin` để thiết lập mã PIN chấm công trong `public.employee_pins`).
     - **Quyền Thiết bị Kiosk (`kiosk`)**: Là tài khoản Auth có `app_metadata.role = 'kiosk'`, **tuyệt đối không** có bản ghi trong bảng `public.employees`, và được liên kết với bảng `public.devices` thông qua quy trình cấp phát (`POST /api/devices`) và ghép nối mã 6 chữ số (`POST /api/devices/pair`).
   - Khi cần kiểm thử sâu các luồng nghiệp vụ local, hãy tạo người dùng qua công cụ Authentication của Supabase Studio local (`http://127.0.0.1:54323`) kết hợp khởi tạo hồ sơ hợp lệ theo đúng schema/RPC của dự án. **Không** tắt RLS và **không** dùng mật khẩu/dữ liệu thật của môi trường production.

---

## 8. Bước 6: Chạy Typecheck, Lint, Build và Smoke E2E Test

Tất cả các lệnh kiểm tra chất lượng mã nguồn dưới đây được chạy từ **thư mục gốc của repo** (trên **Terminal 1**):

### 8.1. Kiểm tra Kiểu dữ liệu (Typecheck) & Lint

```powershell
# Tự động sinh route tree (TanStack Router) và kiểm tra TypeScript trên toàn bộ packages/apps
pnpm typecheck

# Kiểm tra quy chuẩn mã nguồn bằng Biome
pnpm lint
```

*(Nếu cần tự động sửa lỗi lint hoặc định dạng mã nguồn theo cấu hình `package.json`, bạn có thể dùng `pnpm lint:fix` hoặc `pnpm format`).*

### 8.2. Kiểm tra Build toàn bộ Monorepo

Lệnh `build` ở thư mục gốc sẽ biên dịch tuần tự `@timekeeping/shared`, `@timekeeping/web`, và chạy kiểm tra đóng gói (`--dry-run`) cho `@timekeeping/worker`:

```powershell
pnpm build
```

### 8.3. Chạy Bộ Kiểm thử Smoke E2E với Playwright

Cấu hình Playwright (`apps/web/playwright.config.ts`) được thiết kế riêng để **kiểm thử smoke giao diện (UI) và route guard phía client**:
- Playwright sẽ tự động khởi chạy một tiến trình Vite riêng tại địa chỉ `http://127.0.0.1:4173` (`--strictPort`).
- Nếu chưa truyền biến môi trường bên ngoài, cấu hình sẽ tự dùng giá trị placeholder an toàn vì ở tầng smoke UI, Supabase client chỉ kiểm tra phiên đăng nhập cục bộ (`null`) mà **không** thực hiện truy vấn tích hợp hay gọi RPC/RLS vào cơ sở dữ liệu.

**Bước 1: Cài đặt trình duyệt Chromium cho Playwright (chỉ cần chạy lần đầu trên máy mới):**

```powershell
pnpm --filter @timekeeping/web exec playwright install chromium
```

**Bước 2: Chạy bộ test E2E smoke:**

```powershell
pnpm --filter @timekeeping/web test:e2e
```

### 8.4. Cập nhật TypeScript Types từ Database Local (Khi có thay đổi Schema)

Nếu bạn đang phát triển và có chỉnh sửa cấu trúc bảng/hàm SQL trên Supabase local, bạn có thể cập nhật lại kiểu dữ liệu TypeScript cho gói `@timekeeping/shared`.

> **Lưu ý trên Windows PowerShell**: Script `pnpm db:types` trong `package.json` (`supabase gen types typescript --local > packages/shared/src/database.types.ts`) sử dụng toán tử chuyển hướng `>` có thể bị ảnh hưởng bởi bảng mã (encoding UTF-16) mặc định của Windows PowerShell 5.1. Trên PowerShell, khuyến nghị chạy lệnh chuẩn từ thư mục gốc dưới đây để gọi đúng CLI trong workspace và ghi tệp chuẩn UTF-8:

```powershell
pnpm exec supabase gen types typescript --local | Set-Content -Path .\packages\shared\src\database.types.ts -Encoding UTF8
```

*(Nếu chỉ dựng môi trường để chạy thử nghiệm mà không sửa đổi schema DB, bạn **không cần** chạy lệnh này vì tệp `database.types.ts` đã có sẵn trong repo).*

---

## 9. Bước 7: Dừng Môi trường & Reset Database Local

Cần phân biệt rõ thao tác **dừng dịch vụ/container** (`stop`) và thao tác **đặt lại cơ sở dữ liệu** (`db reset`):

### 9.1. Dừng các dịch vụ đang chạy (Không phải lệnh reset DB)

1. **Dừng Web App**: Chuyển sang **Terminal 3**, nhấn tổ hợp phím `Ctrl + C`.
2. **Dừng Cloudflare Worker**: Chuyển sang **Terminal 2**, nhấn tổ hợp phím `Ctrl + C`.
3. **Dừng các container Supabase Local**:
   ```powershell
   pnpm exec supabase stop
   ```
   *(Tùy chọn: Nếu muốn dừng stack container Supabase local mà không tạo bản sao lưu/backup khi dừng, bạn có thể chạy `pnpm exec supabase stop --no-backup`. Lưu ý lệnh `stop` chỉ dừng stack container, không dùng lệnh này như công cụ cam kết xóa sạch dữ liệu DB).*

### 9.2. Reset làm sạch Database Local (Destructive — Chỉ dùng ở Local)

> **CẢNH BÁO DỮ LIỆU (DESTRUCTIVE COMMAND)**: Lệnh `db reset` dưới đây sẽ **xóa toàn bộ dữ liệu hiện có** trong cơ sở dữ liệu container **LOCAL** trên máy của bạn và chạy lại các tệp migration từ đầu. Lệnh này chỉ tác động tới Docker container local, nhưng hãy luôn kiểm tra chắc chắn bạn đang thao tác trên môi trường local trước khi thực thi.

- **Khởi tạo lại DB local từ đầu (xóa dữ liệu local hiện tại và áp dụng lại toàn bộ migrations):**
  ```powershell
  pnpm exec supabase db reset
  ```
  *(Sau khi chạy `db reset`, cơ sở dữ liệu sẽ trở về trạng thái mới chỉ có schema từ migrations. Hãy kiểm tra lại bảng `branches` trên Studio và nạp lại `supabase/seed.sql` theo hướng dẫn tại [Mục 4.3](#43-kiểm-tra-và-nạp-dữ-liệu-mẫu-supabaseseedsql) nếu dữ liệu seed chưa tự động được nạp).*

---

## 10. Xử lý Lỗi Phổ biến (Troubleshooting)

### 10.1. Lỗi Docker Desktop: `permission denied` khi kết nối Docker daemon / named pipe
- **Triệu chứng**: Khi chạy `docker info` hoặc `pnpm exec supabase start`, xuất hiện lỗi dạng `error during connect: ... open //./pipe/dockerDesktopLinuxEngine: Access is denied` hoặc `permission denied`.
- **Nguyên nhân**: Docker Desktop chưa khởi động xong, dịch vụ nền của Docker bị treo, hoặc tài khoản Windows hiện tại chưa có quyền truy cập named pipe của Docker.
- **Cách xử lý**:
  1. Mở ứng dụng **Docker Desktop**, đảm bảo trạng thái ở góc dưới bên trái là **Engine running** (màu xanh).
  2. Nếu Docker Desktop đã mở nhưng vẫn lỗi, nhấn vào biểu tượng Troubleshoot (hình con bọ) trong Docker Desktop -> chọn **Restart**.
  3. Đảm bảo tài khoản Windows của bạn nằm trong nhóm `docker-users` của máy (sau khi thêm vào nhóm cần đăng xuất và đăng nhập lại Windows), hoặc thử mở lại cửa sổ PowerShell mới sau khi Docker Desktop đã khởi chạy hoàn tất.

### 10.2. Lỗi `EPERM: operation not permitted` khi chạy Supabase CLI (`.supabase` trong thư mục người dùng)
- **Triệu chứng**: Khi chạy `pnpm exec supabase ...`, CLI báo lỗi `EPERM` không thể tạo hoặc ghi vào thư mục `C:\Users\<tên-user>\.supabase`.
- **Nguyên nhân**: Tiến trình PowerShell hiện tại bị giới hạn quyền ghi vào thư mục hồ sơ người dùng (`$env:USERPROFILE`), hoặc bị phần mềm bảo mật/sandbox chặn quyền tạo thư mục.
- **Cách xử lý**:
  1. Chạy lệnh trên cửa sổ Windows PowerShell tiêu chuẩn thuộc đúng tài khoản người dùng đang đăng nhập trên máy.
  2. Kiểm tra quyền đọc/ghi của thư mục `$env:USERPROFILE` hoặc tự tạo trước thư mục `.supabase` bằng lệnh:
     ```powershell
     New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.supabase"
     ```

### 10.3. Web App báo lỗi thiếu cấu hình môi trường (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` hoặc `VITE_WORKER_URL`)
- **Nguyên nhân**: Tệp `apps/web/.env.local` chưa được tạo, đặt sai thư mục (ví dụ đặt nhầm ở thư mục gốc thay vì `apps/web/`), thiếu biến `VITE_WORKER_URL=http://localhost:8787`, hoặc tệp bị lưu kèm UTF-8 BOM ở dòng đầu tiên.
- **Cách xử lý**:
  1. Kiểm tra sự tồn tại của tệp: `Test-Path -Path .\apps\web\.env.local` (kết quả phải là `True`).
  2. Kiểm tra nội dung tệp đảm bảo có đủ `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` và `VITE_WORKER_URL=http://localhost:8787` với bảng mã UTF-8 không BOM (xem lại [Mục 5.1](#51-tạo-tệp-appswebenvlocal-cho-ứng-dụng-web)).
  3. Khởi động lại lệnh `pnpm dev:web` ở **Terminal 3**.

### 10.4. Worker API báo lỗi CORS, `401 UNAUTHENTICATED`, `403 FORBIDDEN` hoặc không kết nối được Supabase
- **Nguyên nhân**:
  - Chưa tạo tệp `apps/worker/.dev.vars` nên Worker vẫn dùng địa chỉ giữ chỗ `https://your-project-ref.supabase.co` trong `wrangler.toml`.
  - Gọi các API quản trị (`/api/employees`, `/api/devices`, ...) mà không đính kèm header `Authorization: Bearer <access_token>`, hoặc tài khoản gọi API chưa có bản ghi `role = 'admin'` và `is_active = true` trong bảng `public.employees`.
  - Mở Web App ở một cổng khác `http://localhost:5173` nhưng chưa cập nhật biến `ALLOWED_ORIGIN` trong `apps/worker/.dev.vars`.
- **Cách xử lý**:
  1. Kiểm tra lại tệp `apps/worker/.dev.vars` (xem [Mục 5.2](#52-tạo-tệp-appsworkerdevvars-cho-cloudflare-worker)).
  2. Khởi động lại `pnpm dev:worker` ở **Terminal 2** sau mỗi lần sửa `.dev.vars`.
  3. Kiểm tra endpoint `http://localhost:8787/api/health` trước để xác nhận Worker đang hoạt động bình thường.

### 10.5. Lỗi xung đột cổng (Port `5173`, `8787`, `4173`, hoặc `54321`–`54325` đã bị sử dụng)
- **Triệu chứng**: Vite, Wrangler, Playwright (`--strictPort` ở cổng `4173`) hoặc Supabase báo cổng mạng đã bị chiếm dụng bởi một tiến trình khác.
- **Cách xử lý**:
  Tra cứu PID của tiến trình đang chiếm cổng trên PowerShell (ví dụ kiểm tra cổng `4173` hoặc `5173`):
  ```powershell
  Get-NetTCPConnection -LocalPort 4173 -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, State, OwningProcess
  ```
  Sau đó tìm tên tiến trình và tắt tiến trình bị treo (nếu cần):
  ```powershell
  Get-Process -Id <OwningProcess_PID>
  Stop-Process -Id <OwningProcess_PID> -Force
  ```

### 10.6. Lỗi cấu hình `[inbucket]` trên Supabase CLI 3.0.0 hoặc cần áp dụng thay đổi trong `supabase/config.toml`
- **Triệu chứng**: Khi chạy `pnpm exec supabase start`, CLI báo lỗi `[inbucket] in supabase/config.toml is no longer supported. Use [local_smtp] instead.` hoặc stack local chưa nhận cấu hình mới sau khi chỉnh sửa `supabase/config.toml`.
- **Cách xử lý**:
  1. Đảm bảo `supabase/config.toml` sử dụng phân đoạn `[local_smtp]` (với `port = 54324` cho Web UI Mailpit và `smtp_port = 54325` cho cổng SMTP).
  2. Khởi động lại stack Supabase local bằng hai lệnh tuần tự:
     ```powershell
     pnpm exec supabase stop
     pnpm exec supabase start
     ```
  3. **Lưu ý quan trọng**: **Không** chạy `pnpm exec supabase db reset` để xử lý lỗi cấu hình `config.toml`. Việc chạy `supabase stop` rồi `supabase start` là đủ để nạp cấu hình mới và **dữ liệu DB local được giữ lại**.
