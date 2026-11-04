# Sổ tay Vận hành Hệ thống Chấm công (Operations Runbook)

> [!IMPORTANT]
> **Phân biệt trạng thái công việc trong repository và điều kiện vận hành bên ngoài:**
> - **Đã hoàn tất trong mã nguồn:** Các workflow GitHub Actions (`.github/workflows/deploy.yml`, `.github/workflows/backup.yml`, `.github/workflows/keep-alive.yml`), Cloudflare Worker (`apps/worker/src/index.ts`), ứng dụng Web (`apps/web`) và toàn bộ migrations/RPC PostgreSQL (`supabase/migrations/*`) đã được định nghĩa đầy đủ trong repository.
> - **Điều kiện tiên quyết bên ngoài (External Prerequisites):** Việc triển khai môi trường Production thực tế (cấp phát Supabase project, tạo Cloudflare R2 bucket `timekeeping-backup`, khởi tạo Cloudflare Pages `timekeeping-web`, nạp Secrets) và thiết lập hệ thống giám sát/cảnh báo tự động (monitoring/alerts qua email, Slack, webhook) là các bước cấu hình hạ tầng bên ngoài repository.
> - **Nguyên tắc xác nhận sao lưu:** Các bản sao lưu tự động trên R2 **chưa được coi là đáng tin cậy cho đến khi thực hiện thành công ít nhất một buổi diễn tập khôi phục (restore drill)** trên cơ sở dữ liệu tách biệt.

---

## Mục lục

1. [Danh mục Biến môi trường & Secrets](#1-danh-mục-biến-môi-trường--secrets)
2. [Kiểm tra Sức khỏe Hệ thống Định kỳ (Routine Health Checks)](#2-kiểm-tra-sức-khỏe-hệ-thống-định-kỳ-routine-health-checks)
3. [Quy trình Diễn tập Khôi phục Dữ liệu (Backup Restore Drill)](#3-quy-trình-diễn-tập-khôi-phục-dữ-liệu-backup-restore-drill)
4. [Quy trình Xoay vòng Khóa & Thông tin Xác thực (Secret Rotation)](#4-quy-trình-xoay-vòng-khóa--thông-tin-xác-thực-secret-rotation)
5. [Ứng phó Sự cố (Incident Response Playbooks)](#5-ứng-phó-sự-cố-incident-response-playbooks)

---

## 1. Danh mục Biến môi trường & Secrets

Không bao giờ lưu giá trị thực của mật khẩu, token hoặc khóa bí mật vào Git. Hệ thống sử dụng đúng các tên biến dưới đây theo cấu hình thực tế trong repository:

### 1.1 GitHub Actions Repository Secrets

Được sử dụng bởi `.github/workflows/deploy.yml`, `.github/workflows/backup.yml` và `.github/workflows/keep-alive.yml`:

| Tên Secret | Workflow sử dụng | Mục đích |
|---|---|---|
| `SUPABASE_DB_URL` | `backup.yml` | Chuỗi kết nối PostgreSQL trực tiếp dùng cho `pg_dump` |
| `R2_ACCESS_KEY_ID` | `backup.yml` | Khóa truy cập S3 API của Cloudflare R2 (gán vào `AWS_ACCESS_KEY_ID`) |
| `R2_SECRET_ACCESS_KEY` | `backup.yml` | Khóa bí mật S3 API của Cloudflare R2 (gán vào `AWS_SECRET_ACCESS_KEY`) |
| `R2_ENDPOINT` | `backup.yml` | Endpoint S3 API của Cloudflare R2 (`https://<account_id>.r2.cloudflarestorage.com`) |
| `SUPABASE_URL` | `keep-alive.yml`, `deploy.yml` | URL dự án Supabase; truyền vào lệnh `wrangler deploy --var SUPABASE_URL:...` và ping REST |
| `SUPABASE_ANON_KEY` | `keep-alive.yml` | Khóa công khai (`anon` key) dùng để gửi HTTP request giữ kết nối hàng ngày |
| `VITE_SUPABASE_URL` | `deploy.yml` | URL dự án Supabase nhúng vào bản build `apps/web` |
| `VITE_SUPABASE_ANON_KEY` | `deploy.yml` | Khóa `anon` nhúng vào bản build `apps/web` |
| `VITE_WORKER_URL` | `deploy.yml` | URL gốc của Cloudflare Worker (`timekeeping-worker`) nhúng vào bản build `apps/web` |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml` | Token cấp quyền cho Wrangler triển khai Worker và Cloudflare Pages |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` | ID tài khoản Cloudflare đích |

### 1.2 Cloudflare Worker Secrets & Variables (`timekeeping-worker`)

Được cấu hình thông qua Wrangler CLI hoặc trang quản trị Cloudflare cho `apps/worker` (`apps/worker/wrangler.toml` và `apps/worker/src/index.ts`):

| Tên cấu hình | Phân loại | Cách thiết lập trong dự án hiện tại |
|---|---|---|
| `SUPABASE_ANON_KEY` | Worker Secret | Chạy `pnpm --filter @timekeeping/worker exec wrangler secret put SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker Secret | Chạy `pnpm --filter @timekeeping/worker exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY` |
| `ALLOWED_ORIGIN` | Worker Secret / Biến cấu hình | Danh sách origin được phép gọi CORS (phân tách bằng dấu phẩy, ví dụ `https://timekeeping-web.pages.dev`). Đặt qua `wrangler secret put ALLOWED_ORIGIN` hoặc biến môi trường của Worker |
| `SUPABASE_URL` | Worker Variable (`[vars]`) | Khai báo trong `apps/worker/wrangler.toml` và được ghi đè khi chạy `deploy.yml` bằng cờ `--var SUPABASE_URL:${{ secrets.SUPABASE_URL }}` |

---

## 2. Kiểm tra Sức khỏe Hệ thống Định kỳ (Routine Health Checks)

Thực hiện danh sách kiểm tra (checklist) dưới đây theo lịch vận hành để phát hiện sớm lỗi tác vụ nền hoặc gián đoạn dịch vụ.

### 2.1 Kiểm tra GitHub Actions Workflows

Truy cập tab **Actions** của GitHub repository và rà soát 3 workflow:

1. **Supabase Keep-Alive (`.github/workflows/keep-alive.yml`):**
   - **Lịch chạy định kỳ:** `0 1 * * *` (**01:00 UTC hàng ngày**, tức **08:00 sáng giờ Việt Nam**).
   - **Tiêu chí đạt:** Job `Ping Supabase REST API` báo xanh; log hiển thị `Supabase REST status code: 200` (hoặc mã `2xx`/`3xx`).
   - **Xử lý khi lỗi:** Có thể bấm **Run workflow** (`workflow_dispatch`) để kiểm tra tức thì. Nếu trả mã `401`/`403` hoặc không kết nối được, kiểm tra lại `SUPABASE_URL`, `SUPABASE_ANON_KEY` và trạng thái dự án trên Supabase.

2. **Weekly Database Backup to R2 (`.github/workflows/backup.yml`):**
   - **Lịch chạy định kỳ:** `0 19 * * 6` (**19:00 UTC Thứ Bảy hàng tuần**, tức **02:00 sáng Chủ Nhật giờ Việt Nam**).
   - **Tiêu chí đạt:**
     - Bước `Create compressed database dump` sinh tệp `timekeeping_YYYYMMDD_HHMMSS.dump.gz` có dung lượng lớn hơn 0.
     - Bước `Upload backup to Cloudflare R2` tải tệp thành công lên `s3://timekeeping-backup/weekly/timekeeping_YYYYMMDD_HHMMSS.dump.gz`.
     - Bước `Prune backups older than 12 weeks (keep latest 12)` giữ lại tối đa 12 bản sao lưu mới nhất trong thư mục `weekly/`.

3. **Deploy Worker & Web (`.github/workflows/deploy.yml`):**
   - **Kích hoạt:** Tự động khi `push` vào nhánh `main` hoặc kích hoạt thủ công qua `workflow_dispatch`.
   - **Tiêu chí đạt:** Toàn bộ các bước `Build Shared Package`, `Typecheck & Lint`, `Deploy Cloudflare Worker (timekeeping-worker)`, `Build Web Application`, và `Deploy Cloudflare Pages (timekeeping-web)` hoàn tất không lỗi.

### 2.2 Kiểm tra Trực tiếp Endpoint và Hạ tầng Cloudflare

1. **Kiểm tra Health Endpoint của Worker:**
   Chạy lệnh sau từ thiết bị đầu cuối (terminal):
   ```bash
   curl -i https://<worker-domain>/api/health
   ```
   - Kết quả kỳ vọng: HTTP `200 OK` cùng JSON `{"ok":true,"service":"timekeeping-worker","timestamp":"..."}`.
2. **Kiểm tra trên trang quản trị Cloudflare:**
   - Xác nhận bản phát hành mới nhất của Worker `timekeeping-worker` và dự án Pages `timekeeping-web` (nhánh `main`) đang ở trạng thái hoạt động bình thường.
   - Kiểm tra dung lượng và danh sách đối tượng trong R2 bucket `timekeeping-backup` (thư mục `weekly/`) khớp với lịch sử chạy của `backup.yml`.

### 2.3 Checklist Vận hành Hàng tuần (Dành cho Quản trị viên)

- [ ] Xác nhận workflow `keep-alive.yml` không có ngày nào thất bại trong 7 ngày qua.
- [ ] Xác nhận workflow `backup.yml` rạng sáng Chủ Nhật đã tạo tệp `weekly/timekeeping_*.dump.gz` mới trên R2.
- [ ] Gọi thử `/api/health` trên Worker trả về `{"ok":true}`.
- [ ] Trước mỗi kỳ chốt lương tháng: truy cập `/admin/payroll/preview` để kiểm tra không còn cảnh báo `ORPHANED_PUNCHES` chưa xử lý.

---

## 3. Quy trình Diễn tập Khôi phục Dữ liệu (Backup Restore Drill)

> [!DANGER]
> **NGUYÊN TẮC AN TOÀN TUYỆT ĐỐI:**
> 1. **KHÔNG BAO GIỜ** trỏ lệnh `pg_restore` của buổi diễn tập vào cơ sở dữ liệu Production (`SUPABASE_DB_URL` của môi trường thật).
> 2. Mọi thao tác diễn tập khôi phục bắt buộc phải thực hiện trên một **cơ sở dữ liệu Supabase tạm thời độc lập (isolated throwaway Supabase project / staging database)** hoặc PostgreSQL 17 khởi tạo cục bộ và xóa bỏ ngay sau khi nghiệm thu.
> 3. Hệ thống sao lưu **chưa được chứng minh là hoạt động** cho đến khi quy trình dưới đây chạy thành công từ đầu đến cuối và kiểm tra được dữ liệu bảng/hàm.

### 3.1 Đặc tả Kỹ thuật của Tệp Sao lưu Thực tế

Theo `.github/workflows/backup.yml`, tệp sao lưu được tạo với cấu hình chính xác như sau:
- **Phiên bản công cụ:** `postgresql-client-17` (`pg_dump` 17).
- **Lệnh tạo dump:** `pg_dump --format=custom --compress=0 --no-owner --no-privileges "$SUPABASE_DB_URL" | gzip -9 > "timekeeping_${TIMESTAMP}.dump.gz"`
- **Định dạng lưu trữ:** Custom format của PostgreSQL (`--format=custom`) được nén ngoài bằng `gzip`. Do đó, khi khôi phục bắt buộc phải giải nén lớp `gzip` trước (hoặc dẫn luồng qua `gunzip -c`) rồi mới đưa vào `pg_restore`.
- **Đường dẫn trên R2:** `s3://timekeeping-backup/weekly/timekeeping_YYYYMMDD_HHMMSS.dump.gz`

### 3.2 Các bước Thực hiện Restore Drill trên Database Tạm thời (Throwaway DB)

#### Bước 1: Chuẩn bị môi trường máy trạm và Database đích độc lập
1. Tạo một project Supabase mới tạm thời (throwaway project) hoặc một instance PostgreSQL 17 trống có sẵn các schema nền của Supabase (`auth`, `extensions`).
2. Cài đặt `postgresql-client-17` và `awscli` trên máy thực hiện diễn tập (tương tự môi trường Ubuntu trong `backup.yml`).
3. Thiết lập biến môi trường tạm thời trong phiên shell và kiểm tra chéo để chắc chắn không chứa URL của Production:
   ```bash
   export AWS_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
   export AWS_SECRET_ACCESS_KEY="<R2_SECRET_ACCESS_KEY>"
   export AWS_DEFAULT_REGION="auto"
   export R2_ENDPOINT="<R2_ENDPOINT>"
   export R2_BUCKET="timekeeping-backup"

   # CẢNH BÁO: Chỉ điền chuỗi kết nối của THROWAWAY / STAGING DB
   export DRILL_TARGET_DB_URL="postgresql://postgres:<password>@<throwaway-host>:5432/postgres"
   ```

#### Bước 2: Liệt kê và tải bản sao lưu mới nhất từ Cloudflare R2
```bash
# Liệt kê danh sách các bản sao lưu hàng tuần
aws s3 ls "s3://${R2_BUCKET}/weekly/" --endpoint-url "${R2_ENDPOINT}"

# Chọn tệp mới nhất (ví dụ: timekeeping_20261101_190005.dump.gz) và tải về thư mục tạm
export BACKUP_FILE="timekeeping_YYYYMMDD_HHMMSS.dump.gz"
aws s3 cp "s3://${R2_BUCKET}/weekly/${BACKUP_FILE}" "./${BACKUP_FILE}" \
  --endpoint-url "${R2_ENDPOINT}"
```

#### Bước 3: Giải nén lớp Gzip và kiểm tra mục lục tệp Custom Dump
Trước khi nạp vào database, giải nén tệp `.dump.gz` thành `.dump` và dùng `pg_restore --list` để xác minh tệp không bị hỏng:
```bash
gunzip -k "./${BACKUP_FILE}"
export DUMP_FILE="${BACKUP_FILE%.gz}"

# Kiểm tra danh mục đối tượng bên trong bản dump
pg_restore --list "./${DUMP_FILE}" | head -n 40
```

#### Bước 4: Khôi phục vào Throwaway Database bằng `pg_restore`
Kiểm tra lại tên máy chủ đích một lần nữa trước khi chạy lệnh:
```bash
psql "${DRILL_TARGET_DB_URL}" -c "SELECT current_database(), inet_server_addr();"

# Thực thi pg_restore an toàn (dừng ngay nếu có lỗi, chạy trong 1 transaction, bỏ qua owner/privileges)
pg_restore \
  --verbose \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --exit-on-error \
  --dbname="${DRILL_TARGET_DB_URL}" \
  "./${DUMP_FILE}"
```

#### Bước 5: Nghiệm thu Dữ liệu và Dọn dẹp
1. Chạy truy vấn xác nhận cấu trúc bảng, RLS và dữ liệu trên Throwaway DB:
   ```bash
   psql "${DRILL_TARGET_DB_URL}" -c "
     SELECT 'branches' AS table_name, count(*) FROM public.branches
     UNION ALL
     SELECT 'employees', count(*) FROM public.employees
     UNION ALL
     SELECT 'punches', count(*) FROM public.punches
     UNION ALL
     SELECT 'payroll_periods', count(*) FROM public.payroll_periods;
   "
   ```
2. Kiểm tra sự tồn tại của các hàm RPC cốt lõi (`public.kiosk_lookup`, `public.kiosk_punch`, `public.fn_calculate_payroll_base`, `private.my_role`).
3. **Dọn dẹp sau diễn tập:** Xóa ngay tệp `./${BACKUP_FILE}` và `./${DUMP_FILE}` trên máy trạm; hủy (delete) project/database tạm thời vừa dùng để diễn tập. Lưu lại biên bản ngày giờ diễn tập và tên tệp đã kiểm tra.

---

## 4. Quy trình Xoay vòng Khóa & Thông tin Xác thực (Secret Rotation)

Khi xoay vòng bất kỳ thông tin xác thực nào, luôn cập nhật theo đúng thứ tự phụ thuộc dưới đây để hạn chế thời gian gián đoạn.

### 4.1 Xoay vòng Mật khẩu Cơ sở dữ liệu Supabase (`SUPABASE_DB_URL`)

1. Trên trang quản trị Supabase của dự án, đặt lại mật khẩu Database (Database Password) và tạo chuỗi kết nối URI mới.
2. Trên GitHub repository, vào **Settings → Secrets and variables → Actions**, cập nhật lại secret `SUPABASE_DB_URL` bằng chuỗi kết nối mới.
3. Mở tab **Actions**, chọn workflow **Weekly Database Backup to R2** (`backup.yml`) và nhấn **Run workflow** (`workflow_dispatch`) để xác nhận `pg_dump` kết nối thành công với mật khẩu mới.

### 4.2 Xoay vòng Khóa API Supabase (`SUPABASE_ANON_KEY` & `SUPABASE_SERVICE_ROLE_KEY`)

Việc đổi `anon` key và `service_role` key ảnh hưởng đồng thời đến Worker, ứng dụng Web và workflow Keep-Alive:

1. **Cập nhật trên Cloudflare Worker (`timekeeping-worker`):**
   ```bash
   cd apps/worker
   pnpm exec wrangler secret put SUPABASE_ANON_KEY
   pnpm exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
2. **Cập nhật trên GitHub Actions Secrets:**
   - Cập nhật `SUPABASE_ANON_KEY` (dùng cho `keep-alive.yml`).
   - Cập nhật `VITE_SUPABASE_ANON_KEY` (dùng khi build `apps/web` trong `deploy.yml`).
   - Nếu đổi cả URL dự án Supabase, cập nhật đồng thời `SUPABASE_URL`, `VITE_SUPABASE_URL` và giá trị `SUPABASE_URL` trong `apps/worker/wrangler.toml`.
3. **Triển khai lại Web & Kiểm tra:**
   - Kích hoạt chạy lại workflow **Deploy Worker & Web** (`deploy.yml`) qua `workflow_dispatch` để build lại `apps/web` với `VITE_SUPABASE_ANON_KEY` mới và đẩy lên Cloudflare Pages.
   - Kích hoạt chạy thử workflow **Supabase Keep-Alive** (`keep-alive.yml`) để xác nhận HTTP status `200`.

### 4.3 Xoay vòng Khóa S3 của Cloudflare R2 (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`)

1. Tạo cặp R2 API Token (S3 Access Key ID và Secret Access Key) mới với quyền đọc/ghi trên bucket `timekeeping-backup`.
2. Cập nhật các GitHub Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (và `R2_ENDPOINT` nếu thay đổi tài khoản).
3. Kích hoạt thủ công workflow **Weekly Database Backup to R2** (`backup.yml`) để xác nhận tải tệp `.dump.gz` lên R2 thành công.
4. Thu hồi (revoke) cặp khóa R2 cũ trên Cloudflare.

### 4.4 Xoay vòng `CLOUDFLARE_API_TOKEN`

1. Khởi tạo API Token mới trên Cloudflare với quyền triển khai Cloudflare Workers Scripts và Cloudflare Pages cho tài khoản tương ứng với `CLOUDFLARE_ACCOUNT_ID`.
2. Cập nhật GitHub Secret `CLOUDFLARE_API_TOKEN`.
3. Chạy thử workflow **Deploy Worker & Web** (`deploy.yml`) để xác nhận bước `wrangler deploy` và `wrangler pages deploy` hoạt động bình thường, sau đó thu hồi token cũ.

### 4.5 Cập nhật Tên miền Web / Worker (`ALLOWED_ORIGIN` & `VITE_WORKER_URL`)

- **Khi thêm hoặc đổi tên miền của ứng dụng Web (`timekeeping-web`):**
  - Worker kiểm tra CORS thông qua biến `ALLOWED_ORIGIN` (hỗ trợ danh sách nhiều origin cách nhau bởi dấu phẩy trong `apps/worker/src/index.ts`).
  - Cập nhật giá trị mới cho Worker:
    ```bash
    cd apps/worker
    pnpm exec wrangler secret put ALLOWED_ORIGIN
    # Nhập ví dụ: https://timekeeping-web.pages.dev,https://chamcong.tencongty.vn
    ```
- **Khi đổi URL của Cloudflare Worker (`timekeeping-worker`):**
  - Cập nhật GitHub Secret `VITE_WORKER_URL` (không có dấu `/` ở cuối, hoặc theo đúng chuẩn URL gốc mà frontend gọi `/api/*`).
  - Chạy lại workflow **Deploy Worker & Web** (`deploy.yml`) để `apps/web` được build lại với địa chỉ Worker mới.

---

## 5. Ứng phó Sự cố (Incident Response Playbooks)

### 5.1 Rollback bản Triển khai Lỗi (Deploy Rollback)

Khi bản cập nhật mới trên nhánh `main` gây lỗi giao diện Web hoặc lỗi API trên Worker:

1. **Xác định phạm vi ảnh hưởng:**
   - Kiểm tra `/api/health` và log của workflow `deploy.yml`.
   - Lưu ý: Workflow `deploy.yml` triển khai đồng thời cả `apps/worker` (`timekeeping-worker`) và `apps/web` (`timekeeping-web`) từ mã nguồn nhánh `main`.
2. **Thực hiện Rollback qua Git (Khuyến nghị để đồng bộ `shared`, `worker` và `web`):**
   ```bash
   git checkout main
   git pull origin main
   git revert <bad_commit_sha> --no-edit
   git push origin main
   ```
   - Sự kiện `push` lên `main` sẽ tự động kích hoạt `.github/workflows/deploy.yml` để kiểm tra lại `pnpm lint`, `pnpm typecheck` và triển khai lại cả Worker lẫn Pages về trạng thái ổn định trước đó.
3. **Lưu ý khi có thay đổi Database Schema:**
   - Nếu sự cố liên quan đến migration SQL trong `supabase/migrations/`, việc revert code TypeScript không tự hoàn tác schema trên PostgreSQL. Phải viết migration sửa lỗi tiến tới (forward-fix migration) thay vì xóa hoặc sửa trực tiếp lịch sử bảng có dữ liệu lương/chấm công.

### 5.2 Nghi ngờ Lộ lọt Thông tin Xác thực (Suspected Credential Exposure)

Xử lý ngay lập tức theo từng loại thông tin nghi bị lộ:

1. **Nghi lộ `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `R2_SECRET_ACCESS_KEY` hoặc `CLOUDFLARE_API_TOKEN`:**
   - Thực hiện ngay quy trình xoay vòng khóa tương ứng tại [Mục 4](#4-quy-trình-xoay-vòng-khóa--thông-tin-xác-thực-secret-rotation) và hủy khóa cũ.
   - Rà soát bảng `public.audit_log`, `public.employees`, `public.devices`, `public.punches` và `public.payroll_periods` để kiểm tra các thay đổi bất thường trong khoảng thời gian nghi bị lộ.
2. **Nghi lộ tài khoản Admin / Manager hoặc nhân viên:**
   - Nếu nghi lộ tài khoản nhân sự đang có quyền cao, Admin có thể hạ `role` hoặc đặt `is_active = false` trong bảng `public.employees`. Nhờ hàm `private.my_role()` và middleware kiểm tra trực tiếp bảng `employees` trên Worker, quyền truy cập sẽ bị chặn **ngay lập tức ở request kế tiếp** mà không cần chờ JWT hết hạn.
   - Sử dụng chức năng đặt lại mật khẩu của Admin (`POST /api/employees/:id/reset-password`) và đặt lại mã PIN qua RPC `reset_pin`.
3. **Thất lạc hoặc nghi lộ phiên đăng nhập iPad Kiosk:**
   - Admin thực hiện thu hồi thiết bị ngay trên giao diện quản trị (gọi `POST /api/devices/:id/revoke` trên Worker).
   - Thao tác này sẽ cập nhật `devices.revoked_at` (chặn tức thì `kiosk_lookup` và `kiosk_punch` với mã lỗi `DEVICE_REVOKED`) đồng thời khóa tài khoản Auth của kiosk (`ban_duration: '876000h'`).

### 5.3 Leo thang Khôi phục Cơ sở dữ liệu (Database Restore Escalation)

Vì việc ghi đè dữ liệu lên Production có nguy cơ làm mất toàn bộ các lượt chấm công phát sinh sau thời điểm sao lưu (tối đa 1 tuần nếu dùng bản dump hàng tuần trên R2), tuyệt đối **không tự ý chạy `pg_restore` đè lên Production** khi chưa thực hiện các bước đánh giá sau:

1. **Phân loại sự cố dữ liệu:**
   - **Sai sót dữ liệu chấm công đơn lẻ:** Không khôi phục DB. Sử dụng các RPC nghiệp vụ có sẵn (`correct_punch`, `add_manual_punch`, `void_punch`) để điều chỉnh có lưu vết `audit_log`.
   - **Sự cố hỏng dữ liệu diện rộng hoặc xóa nhầm cấu trúc:** Đình chỉ ngay thao tác thay đổi dữ liệu và báo cáo người có thẩm quyền phê duyệt khôi phục (Admin hệ thống / Chủ dự án).
2. **Quy trình khôi phục có kiểm soát:**
   - **Bước 1:** Luôn khôi phục bản `weekly/timekeeping_*.dump.gz` từ R2 vào một **Staging/Recovery Database tách biệt** trước (theo đúng quy trình ở [Mục 3.2](#32-các-bước-thực-hiện-restore-drill-trên-database-tạm-thời-throwaway-db)).
   - **Bước 2:** Đối chiếu dữ liệu giữa Staging/Recovery DB và Production DB để xác định chính xác khoảng thời gian dữ liệu bị thiếu hụt (`punches`, `shifts`, `audit_log`).
   - **Bước 3:** Tùy mức độ thiệt hại, ưu tiên trích xuất dữ liệu bị mất từ Recovery DB sang Production DB, hoặc chuyển đổi cấu hình kết nối (`SUPABASE_URL`, `SUPABASE_DB_URL`, keys) sang instance mới đã được kiểm tra toàn vẹn sau khi có xác nhận chính thức.

### 5.4 Mất kết nối tại iPad Kiosk / Gián đoạn Mạng tại Chi nhánh (Kiosk Outage / Offline Behavior)

Khi chi nhánh báo cáo iPad kiosk không chấm công được hoặc mất mạng internet:

1. **Nắm vững hành vi thiết kế của Kiosk khi Offline:**
   - Theo kiến trúc hệ thống (`docs/architecture.md`), ứng dụng Web sẽ phát hiện sự kiện `offline`/`online` và hiển thị cảnh báo mất kết nối.
   - **Kiosk tuyệt đối KHÔNG lưu đệm (cache) lượt chấm công lúc mất mạng để gửi bù sau**, vì thời điểm chấm công (`at`) bắt buộc lấy từ đồng hồ của PostgreSQL server (`clock_timestamp()`).
   - RPC `kiosk_punch` **không có idempotency key** và không tự động retry ngầm khi rớt mạng giữa chừng nhằm tránh ghi nhận sai trạng thái chuyển tiếp của nhân viên.
2. **Hướng dẫn Xử lý tại Chi nhánh trong thời gian mất mạng:**
   - Nếu iPad chỉ bị kẹt phiên hoặc mất kết nối Wi-Fi cục bộ: chuyển sang mạng dự phòng (4G/Hotspot). Khi có mạng lại, nhân viên nhập mã nhân viên để `kiosk_lookup` hiển thị trạng thái hiện tại trên toàn hệ thống (`off`, `working`, hoặc `on_break`) trước khi bấm nút thao tác tiếp theo.
   - Nếu một nhân viên vừa bấm chấm công đúng lúc rớt mạng và không rõ kết quả đã lên server hay chưa: kiểm tra lại bằng `kiosk_lookup` (nhập mã nhân viên) hoặc nhờ Manager xem danh sách đang trong ca tại `/admin/punches` trước khi thực hiện lại.
   - Nếu mất mạng kéo dài hoặc hỏng phần cứng iPad:
     - Nhân viên có thể chấm công tạm tại bất kỳ iPad hợp lệ nào khác trong cùng chi nhánh hoặc chi nhánh lân cận (hệ thống cho phép chấm công liên chi nhánh).
     - Nếu không có iPad thay thế, Manager chi nhánh ghi nhận lại thời điểm thực tế của nhân viên và sử dụng chức năng thêm/sửa lượt chấm thủ công tại `/admin/punches` (`add_manual_punch` / `correct_punch`, bắt buộc nhập lý do `reason` để lưu vào `audit_log`) ngay khi có kết nối.
     - Nếu cần thay thế iPad mới, Admin thu hồi thiết bị hỏng (`POST /api/devices/:id/revoke`) và cấp mã ghép nối 6 số mới (`POST /api/devices`, có hiệu lực 10 phút) để thiết lập iPad thay thế.