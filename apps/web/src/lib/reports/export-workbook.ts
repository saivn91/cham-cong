import type { Border, Cell, Fill, Font, Workbook, Worksheet } from 'exceljs';

/**
 * Chi tiết khoản phụ cấp biến đổi trong tháng của một nhân viên.
 */
export interface PayrollMonthlyAllowanceItem {
  amount: number;
  reason: string;
}

/**
 * Dữ liệu từng dòng nhân viên cho báo cáo bảng lương tháng.
 */
export interface PayrollWorkbookRowInput {
  employee_code: string;
  full_name: string;
  branch_name: string;
  hourly_rate_snapshot: number;
  minutes_regular_day: number;
  minutes_regular_night: number;
  minutes_ot_day: number;
  minutes_ot_night: number;
  minutes_holiday_day: number;
  minutes_holiday_night: number;
  /**
   * Thành phần lương theo giờ chỉ phục vụ hiển thị, được phía gọi dẫn xuất từ đơn giá snapshot
   * và 6 nhóm số phút đã duyệt; tuyệt đối không ghi đè hay tính lại `total_salary` đã lưu cố định.
   */
  hourly_pay_subtotal: number;
  fixed_allowance_snapshot: number;
  monthly_allowances: readonly PayrollMonthlyAllowanceItem[];
  total_salary: number;
}

/**
 * Đầu vào xuất file Excel bảng lương tháng.
 */
export interface ExportPayrollWorkbookInput {
  year: number;
  month: number;
  branchLabel: string;
  exportedAt: Date | string;
  rows: readonly PayrollWorkbookRowInput[];
}

/**
 * Dữ liệu từng dòng ngày công của nhân viên cho báo cáo chấm công.
 */
export interface TimesheetWorkbookRowInput {
  employee_code: string;
  full_name: string;
  branch_name: string;
  /** Ngày theo múi giờ Việt Nam định dạng YYYY-MM-DD */
  date: string;
  work_hours: number;
  overtime_hours: number;
  session_count: number;
  status?: string | null;
}

/**
 * Đầu vào xuất file Excel bảng chấm công chi nhánh.
 */
export interface ExportTimesheetWorkbookInput {
  year: number;
  month: number;
  branchCode?: string | null;
  exportedAt: Date | string;
  rows: readonly TimesheetWorkbookRowInput[];
}

const VND_NUMBER_FORMAT = '#,##0 "₫"';
const INTEGER_NUMBER_FORMAT = '#,##0';
const HOURS_NUMBER_FORMAT = '#,##0.00';

const FORMULA_DANGEROUS_PREFIX = /^[=+\-@]/;

/**
 * Làm sạch chuỗi văn bản từ người dùng hoặc DB để chống thực thi công thức độc hại (Formula Injection)
 * khi mở trong Microsoft Excel / LibreOffice Calc.
 */
function sanitizeSafeSpreadsheetText(raw: string | null | undefined): string {
  if (raw == null) {
    return '';
  }
  const normalized = String(raw).replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) {
    return '';
  }
  const firstNonWhitespace = normalized.trimStart();
  if (
    FORMULA_DANGEROUS_PREFIX.test(normalized) ||
    FORMULA_DANGEROUS_PREFIX.test(firstNonWhitespace)
  ) {
    return `'${normalized}`;
  }
  return normalized;
}

/**
 * Đảm bảo giá trị số hợp lệ để ghi vào ô Excel, tránh NaN hoặc Infinity làm hỏng công thức tổng.
 */
function toSafeFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Định dạng kỳ báo cáo YYYY-MM chuẩn để đặt tên tệp.
 */
function formatYearMonthToken(year: number, month: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Năm báo cáo không hợp lệ: ${String(year)}.`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Tháng báo cáo không hợp lệ: ${String(month)}.`);
  }
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/**
 * Định dạng thời điểm kết xuất báo cáo theo chuẩn hiển thị tiếng Việt (Asia/Ho_Chi_Minh).
 */
function formatExportTimestampVi(exportedAt: Date | string): string {
  const parsed = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  if (Number.isNaN(parsed.getTime())) {
    return sanitizeSafeSpreadsheetText(String(exportedAt));
  }
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(parsed);
}

/**
 * Làm sạch mã chi nhánh khi đưa vào tên file xuất ra trình duyệt.
 */
function sanitizeBranchCodeForFilename(branchCode: string | null | undefined): string {
  const trimmed = (branchCode ?? '').trim();
  if (!trimmed || trimmed.toUpperCase() === 'ALL' || trimmed.toUpperCase() === 'TAT_CA') {
    return 'TAT_CA';
  }
  const normalized = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized.length > 0 ? normalized : 'TAT_CA';
}

/**
 * Ghép danh sách phụ cấp phát sinh trong tháng thành chuỗi dễ đọc cho kế toán.
 */
function formatMonthlyAllowanceDetails(
  items: readonly PayrollMonthlyAllowanceItem[],
): { totalAmount: number; detailText: string } {
  if (!items || items.length === 0) {
    return { totalAmount: 0, detailText: 'Không có' };
  }

  let totalAmount = 0;
  const parts: string[] = [];

  for (const item of items) {
    const amount = toSafeFiniteNumber(item.amount);
    totalAmount += amount;
    const formattedAmount = new Intl.NumberFormat('vi-VN').format(Math.round(amount));
    const reasonText = item.reason?.trim() ? item.reason.trim() : 'Phụ cấp khác';
    parts.push(`${reasonText}: ${formattedAmount} ₫`);
  }

  return {
    totalAmount,
    detailText: sanitizeSafeSpreadsheetText(parts.join('; ')),
  };
}

/**
 * Nạp động thư viện ExcelJS ở phía trình duyệt để tránh đưa bundle nặng vào luồng khởi tạo ban đầu.
 */
async function createBrowserWorkbook(): Promise<Workbook> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Chức năng xuất Excel chỉ hỗ trợ chạy trực tiếp trên trình duyệt.');
  }

  const excelJsModule = await import('exceljs');
  const WorkbookConstructor =
    excelJsModule.Workbook ??
    (excelJsModule.default as { Workbook?: typeof excelJsModule.Workbook } | undefined)?.Workbook;

  if (!WorkbookConstructor) {
    throw new Error('Không thể khởi tạo trình tạo bảng tính ExcelJS trên trình duyệt.');
  }

  const workbook = new WorkbookConstructor();
  workbook.creator = 'Timekeeping Payroll System';
  workbook.created = new Date();
  workbook.modified = new Date();
  return workbook;
}

/**
 * Ghi workbook ra buffer và kích hoạt tải xuống tệp .xlsx qua Blob URL, luôn giải phóng URL trong finally.
 */
async function downloadWorkbookInBrowser(workbook: Workbook, filename: string): Promise<void> {
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    if (anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    URL.revokeObjectURL(objectUrl);
  }
}

const THIN_BORDER: Partial<BordersStyle> = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

type BordersStyle = {
  top: Partial<Border>;
  left: Partial<Border>;
  bottom: Partial<Border>;
  right: Partial<Border>;
};

const HEADER_FILL: Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A8A' },
};

const TOTAL_ROW_FILL: Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF3F4F6' },
};

const HEADER_FONT: Partial<Font> = {
  name: 'Arial',
  size: 10,
  bold: true,
  color: { argb: 'FFFFFFFF' },
};

const DATA_FONT: Partial<Font> = {
  name: 'Arial',
  size: 10,
  bold: false,
  color: { argb: 'FF111827' },
};

const TOTAL_FONT: Partial<Font> = {
  name: 'Arial',
  size: 10,
  bold: true,
  color: { argb: 'FF111827' },
};

/**
 * Gán chuỗi văn bản an toàn vào ô Excel và ép kiểu dữ liệu của ô là chuỗi ký tự thuần.
 */
function setSafeStringCell(cell: Cell, text: string | null | undefined): void {
  const safeValue = sanitizeSafeSpreadsheetText(text);
  cell.value = safeValue;
}

/**
 * Áp dụng viền mảnh và phông chữ tiêu chuẩn cho toàn bộ các cột trên một dòng.
 */
function styleRowRange(
  worksheet: Worksheet,
  rowNumber: number,
  columnCount: number,
  font: Partial<Font>,
  fill?: Fill,
): void {
  const row = worksheet.getRow(rowNumber);
  for (let col = 1; col <= columnCount; col += 1) {
    const cell = row.getCell(col);
    cell.font = font;
    cell.border = THIN_BORDER;
    if (fill) {
      cell.fill = fill;
    }
  }
}

/**
 * Xuất tệp Excel Bảng Lương Tháng (`Bang_Luong_Thang_YYYY-MM.xlsx`).
 * Hàm từ chối xuất nếu danh sách nhân viên rỗng để tránh tạo báo cáo trống sai lệch.
 */
export async function exportPayrollWorkbook(input: ExportPayrollWorkbookInput): Promise<string> {
  const yearMonth = formatYearMonthToken(input.year, input.month);

  if (!input.rows || input.rows.length === 0) {
    throw new Error('Không có dữ liệu bảng lương trong kỳ đã chọn để xuất tệp Excel.');
  }

  const workbook = await createBrowserWorkbook();
  const worksheet = workbook.addWorksheet(`Bang_Luong_${yearMonth}`, {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });

  const totalColumns = 16;

  // Cấu hình độ rộng từng cột để hiển thị đầy đủ số tiền VND và tên tiếng Việt
  worksheet.columns = [
    { key: 'stt', width: 7 },
    { key: 'employee_code', width: 16 },
    { key: 'full_name', width: 26 },
    { key: 'branch_name', width: 22 },
    { key: 'hourly_rate_snapshot', width: 18 },
    { key: 'minutes_regular_day', width: 15 },
    { key: 'minutes_regular_night', width: 15 },
    { key: 'minutes_ot_day', width: 17 },
    { key: 'minutes_ot_night', width: 17 },
    { key: 'minutes_holiday_day', width: 15 },
    { key: 'minutes_holiday_night', width: 15 },
    { key: 'hourly_pay_subtotal', width: 20 },
    { key: 'fixed_allowance_snapshot', width: 18 },
    { key: 'variable_allowance_total', width: 20 },
    { key: 'variable_allowance_detail', width: 38 },
    { key: 'total_salary', width: 22 },
  ];

  // Dòng 1: Tiêu đề báo cáo chính
  worksheet.mergeCells(1, 1, 1, totalColumns);
  const titleCell = worksheet.getCell(1, 1);
  setSafeStringCell(
    titleCell,
    `BẢNG LƯƠNG THÁNG ${String(input.month).padStart(2, '0')}/${String(input.year)}`,
  );
  titleCell.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).height = 28;

  // Dòng 2: Thông tin chi nhánh
  worksheet.mergeCells(2, 1, 2, totalColumns);
  const branchMetaCell = worksheet.getCell(2, 1);
  setSafeStringCell(
    branchMetaCell,
    `Phạm vi chi nhánh: ${input.branchLabel?.trim() || 'Tất cả chi nhánh'}`,
  );
  branchMetaCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF374151' } };
  branchMetaCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // Dòng 3: Thời gian kết xuất báo cáo
  worksheet.mergeCells(3, 1, 3, totalColumns);
  const timestampMetaCell = worksheet.getCell(3, 1);
  setSafeStringCell(
    timestampMetaCell,
    `Thời điểm kết xuất: ${formatExportTimestampVi(input.exportedAt)} | Tổng số nhân sự: ${String(input.rows.length)}`,
  );
  timestampMetaCell.font = { name: 'Arial', size: 10, color: { argb: 'FF4B5563' } };
  timestampMetaCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // Dòng 4 để trống tạo khoảng cách nhìn rõ ràng
  worksheet.getRow(4).height = 10;

  // Dòng 5: Tiêu đề cột tiếng Việt
  const headerTitles = [
    'STT',
    'Mã NV',
    'Họ và tên',
    'Chi nhánh',
    'Đơn giá giờ (₫)',
    'Phút thường ngày',
    'Phút thường đêm',
    'Phút tăng ca ngày (150%)',
    'Phút tăng ca đêm (180%)',
    'Phút lễ ngày',
    'Phút lễ đêm',
    'Lương theo giờ (₫)',
    'Phụ cấp cố định (₫)',
    'Phụ cấp phát sinh (₫)',
    'Chi tiết phụ cấp phát sinh',
    'Tổng lương thực nhận (₫)',
  ];

  const headerRowNumber = 5;
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.height = 32;

  headerTitles.forEach((title, idx) => {
    const cell = headerRow.getCell(idx + 1);
    setSafeStringCell(cell, title);
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };
  });
  styleRowRange(worksheet, headerRowNumber, totalColumns, HEADER_FONT, HEADER_FILL);

  // Ghi dữ liệu từng nhân viên bắt đầu từ dòng 6
  const firstDataRowNumber = 6;

  input.rows.forEach((item, index) => {
    const currentRowNumber = firstDataRowNumber + index;
    const row = worksheet.getRow(currentRowNumber);
    row.height = 22;

    const allowanceSummary = formatMonthlyAllowanceDetails(item.monthly_allowances);

    // Cột 1: STT
    const sttCell = row.getCell(1);
    sttCell.value = index + 1;
    sttCell.numFmt = INTEGER_NUMBER_FORMAT;
    sttCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Cột 2..4: Thông tin định danh nhân viên (chống formula injection)
    const codeCell = row.getCell(2);
    setSafeStringCell(codeCell, item.employee_code);
    codeCell.alignment = { vertical: 'middle', horizontal: 'center' };

    const nameCell = row.getCell(3);
    setSafeStringCell(nameCell, item.full_name);
    nameCell.alignment = { vertical: 'middle', horizontal: 'left' };

    const branchCell = row.getCell(4);
    setSafeStringCell(branchCell, item.branch_name);
    branchCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Cột 5: Đơn giá giờ
    const hourlyRateCell = row.getCell(5);
    hourlyRateCell.value = toSafeFiniteNumber(item.hourly_rate_snapshot);
    hourlyRateCell.numFmt = VND_NUMBER_FORMAT;
    hourlyRateCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Cột 6..11: Sáu nhóm số phút làm việc theo đúng cột bảng payroll
    const minuteValues = [
      item.minutes_regular_day,
      item.minutes_regular_night,
      item.minutes_ot_day,
      item.minutes_ot_night,
      item.minutes_holiday_day,
      item.minutes_holiday_night,
    ];
    minuteValues.forEach((minutesValue, minuteIdx) => {
      const minuteCell = row.getCell(6 + minuteIdx);
      minuteCell.value = toSafeFiniteNumber(minutesValue);
      minuteCell.numFmt = INTEGER_NUMBER_FORMAT;
      minuteCell.alignment = { vertical: 'middle', horizontal: 'right' };
    });

    // Cột 12: Thành phần lương theo giờ hiển thị (dẫn xuất từ snapshot đơn giá + 6 nhóm phút, không ghi đè total_salary)
    const hourlySubtotalCell = row.getCell(12);
    hourlySubtotalCell.value = toSafeFiniteNumber(item.hourly_pay_subtotal);
    hourlySubtotalCell.numFmt = VND_NUMBER_FORMAT;
    hourlySubtotalCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Cột 13: Phụ cấp cố định
    const fixedAllowanceCell = row.getCell(13);
    fixedAllowanceCell.value = toSafeFiniteNumber(item.fixed_allowance_snapshot);
    fixedAllowanceCell.numFmt = VND_NUMBER_FORMAT;
    fixedAllowanceCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Cột 14: Tổng phụ cấp phát sinh trong tháng
    const variableAllowanceTotalCell = row.getCell(14);
    variableAllowanceTotalCell.value = allowanceSummary.totalAmount;
    variableAllowanceTotalCell.numFmt = VND_NUMBER_FORMAT;
    variableAllowanceTotalCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Cột 15: Chi tiết các khoản phụ cấp phát sinh (văn bản an toàn)
    const variableAllowanceDetailCell = row.getCell(15);
    setSafeStringCell(variableAllowanceDetailCell, allowanceSummary.detailText);
    variableAllowanceDetailCell.alignment = {
      vertical: 'middle',
      horizontal: 'left',
      wrapText: true,
    };

    // Cột 16: Tổng lương thực nhận (giá trị snapshot bất biến từ DB)
    const totalSalaryCell = row.getCell(16);
    totalSalaryCell.value = toSafeFiniteNumber(item.total_salary);
    totalSalaryCell.numFmt = VND_NUMBER_FORMAT;
    totalSalaryCell.alignment = { vertical: 'middle', horizontal: 'right' };

    styleRowRange(worksheet, currentRowNumber, totalColumns, DATA_FONT);
  });

  const lastDataRowNumber = firstDataRowNumber + input.rows.length - 1;
  const totalRowNumber = lastDataRowNumber + 1;
  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.height = 26;

  // Gộp 5 cột đầu làm nhãn TỔNG CỘNG
  worksheet.mergeCells(totalRowNumber, 1, totalRowNumber, 5);
  const totalLabelCell = totalRow.getCell(1);
  setSafeStringCell(totalLabelCell, 'TỔNG CỘNG');
  totalLabelCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // Thiết lập công thức SUM cho 6 cột số phút (cột F đến K)
  const minuteColumnLetters = ['F', 'G', 'H', 'I', 'J', 'K'] as const;
  minuteColumnLetters.forEach((colLetter, idx) => {
    const cell = totalRow.getCell(6 + idx);
    const sumResult = input.rows.reduce((acc, row) => {
      const values = [
        row.minutes_regular_day,
        row.minutes_regular_night,
        row.minutes_ot_day,
        row.minutes_ot_night,
        row.minutes_holiday_day,
        row.minutes_holiday_night,
      ];
      return acc + toSafeFiniteNumber(values[idx] ?? 0);
    }, 0);

    cell.value = {
      formula: `SUM(${colLetter}${String(firstDataRowNumber)}:${colLetter}${String(lastDataRowNumber)})`,
      result: sumResult,
    };
    cell.numFmt = INTEGER_NUMBER_FORMAT;
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
  });

  // Công thức SUM cho các cột tiền tệ: L (Lương theo giờ), M (Phụ cấp cố định), N (Phụ cấp phát sinh), P (Tổng lương)
  const currencySumColumns: ReadonlyArray<{
    colIndex: number;
    colLetter: string;
    computeResult: () => number;
  }> = [
    {
      colIndex: 12,
      colLetter: 'L',
      computeResult: () =>
        input.rows.reduce((sum, r) => sum + toSafeFiniteNumber(r.hourly_pay_subtotal), 0),
    },
    {
      colIndex: 13,
      colLetter: 'M',
      computeResult: () =>
        input.rows.reduce((sum, r) => sum + toSafeFiniteNumber(r.fixed_allowance_snapshot), 0),
    },
    {
      colIndex: 14,
      colLetter: 'N',
      computeResult: () =>
        input.rows.reduce(
          (sum, r) => sum + formatMonthlyAllowanceDetails(r.monthly_allowances).totalAmount,
          0,
        ),
    },
    {
      colIndex: 16,
      colLetter: 'P',
      computeResult: () =>
        input.rows.reduce((sum, r) => sum + toSafeFiniteNumber(r.total_salary), 0),
    },
  ];

  for (const colConfig of currencySumColumns) {
    const cell = totalRow.getCell(colConfig.colIndex);
    cell.value = {
      formula: `SUM(${colConfig.colLetter}${String(firstDataRowNumber)}:${colConfig.colLetter}${String(lastDataRowNumber)})`,
      result: colConfig.computeResult(),
    };
    cell.numFmt = VND_NUMBER_FORMAT;
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
  }

  // Ô cột 15 trên dòng tổng để trống có định dạng
  setSafeStringCell(totalRow.getCell(15), '');

  styleRowRange(worksheet, totalRowNumber, totalColumns, TOTAL_FONT, TOTAL_ROW_FILL);

  // Bật bộ lọc tự động trên vùng dữ liệu
  worksheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: lastDataRowNumber, column: totalColumns },
  };

  const filename = `Bang_Luong_Thang_${yearMonth}.xlsx`;
  await downloadWorkbookInBrowser(workbook, filename);
  return filename;
}

/**
 * Xuất tệp Excel Bảng Chấm Công Chi Nhánh (`Bang_Cong_Chi_Nhanh_<BRANCH>_YYYY-MM.xlsx`).
 * Hàm từ chối xuất nếu danh sách dòng ngày công rỗng để đảm bảo người dùng nhận được phản hồi rõ ràng.
 */
export async function exportTimesheetWorkbook(input: ExportTimesheetWorkbookInput): Promise<string> {
  const yearMonth = formatYearMonthToken(input.year, input.month);

  if (!input.rows || input.rows.length === 0) {
    throw new Error('Không có dữ liệu chấm công trong kỳ đã chọn để xuất tệp Excel.');
  }

  const sanitizedBranchToken = sanitizeBranchCodeForFilename(input.branchCode);
  const workbook = await createBrowserWorkbook();
  const worksheet = workbook.addWorksheet(`Bang_Cong_${yearMonth}`, {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });

  const totalColumns = 9;

  worksheet.columns = [
    { key: 'stt', width: 7 },
    { key: 'employee_code', width: 16 },
    { key: 'full_name', width: 26 },
    { key: 'branch_name', width: 24 },
    { key: 'date', width: 16 },
    { key: 'work_hours', width: 18 },
    { key: 'overtime_hours', width: 18 },
    { key: 'session_count', width: 15 },
    { key: 'status', width: 32 },
  ];

  // Dòng 1: Tiêu đề chính
  worksheet.mergeCells(1, 1, 1, totalColumns);
  const titleCell = worksheet.getCell(1, 1);
  setSafeStringCell(
    titleCell,
    `BẢNG CHẤM CÔNG CHI TIẾT THÁNG ${String(input.month).padStart(2, '0')}/${String(input.year)}`,
  );
  titleCell.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).height = 28;

  // Dòng 2: Thông tin mã chi nhánh
  worksheet.mergeCells(2, 1, 2, totalColumns);
  const branchCellMeta = worksheet.getCell(2, 1);
  const displayBranchCode =
    sanitizedBranchToken === 'TAT_CA' ? 'Tất cả chi nhánh (TAT_CA)' : sanitizedBranchToken;
  setSafeStringCell(branchCellMeta, `Mã chi nhánh: ${displayBranchCode}`);
  branchCellMeta.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF374151' } };
  branchCellMeta.alignment = { vertical: 'middle', horizontal: 'center' };

  // Dòng 3: Thời điểm kết xuất
  worksheet.mergeCells(3, 1, 3, totalColumns);
  const exportTimeCell = worksheet.getCell(3, 1);
  setSafeStringCell(
    exportTimeCell,
    `Thời điểm kết xuất: ${formatExportTimestampVi(input.exportedAt)} | Tổng số dòng công: ${String(input.rows.length)}`,
  );
  exportTimeCell.font = { name: 'Arial', size: 10, color: { argb: 'FF4B5563' } };
  exportTimeCell.alignment = { vertical: 'middle', horizontal: 'center' };

  worksheet.getRow(4).height = 10;

  // Dòng 5: Tiêu đề cột
  const headerTitles = [
    'STT',
    'Mã NV',
    'Họ và tên',
    'Chi nhánh',
    'Ngày (VN)',
    'Giờ công chuẩn',
    'Giờ tăng ca',
    'Số ca chấm công',
    'Trạng thái / Cảnh báo',
  ];

  const headerRowNumber = 5;
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.height = 30;

  headerTitles.forEach((title, idx) => {
    const cell = headerRow.getCell(idx + 1);
    setSafeStringCell(cell, title);
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };
  });
  styleRowRange(worksheet, headerRowNumber, totalColumns, HEADER_FONT, HEADER_FILL);

  // Dữ liệu từng dòng ngày công thực tế từ truy vấn
  const firstDataRowNumber = 6;

  input.rows.forEach((item, index) => {
    const currentRowNumber = firstDataRowNumber + index;
    const row = worksheet.getRow(currentRowNumber);
    row.height = 21;

    const sttCell = row.getCell(1);
    sttCell.value = index + 1;
    sttCell.numFmt = INTEGER_NUMBER_FORMAT;
    sttCell.alignment = { vertical: 'middle', horizontal: 'center' };

    const empCodeCell = row.getCell(2);
    setSafeStringCell(empCodeCell, item.employee_code);
    empCodeCell.alignment = { vertical: 'middle', horizontal: 'center' };

    const fullNameCell = row.getCell(3);
    setSafeStringCell(fullNameCell, item.full_name);
    fullNameCell.alignment = { vertical: 'middle', horizontal: 'left' };

    const branchNameCell = row.getCell(4);
    setSafeStringCell(branchNameCell, item.branch_name);
    branchNameCell.alignment = { vertical: 'middle', horizontal: 'left' };

    const dateCell = row.getCell(5);
    setSafeStringCell(dateCell, item.date);
    dateCell.alignment = { vertical: 'middle', horizontal: 'center' };

    const workHoursCell = row.getCell(6);
    workHoursCell.value = toSafeFiniteNumber(item.work_hours);
    workHoursCell.numFmt = HOURS_NUMBER_FORMAT;
    workHoursCell.alignment = { vertical: 'middle', horizontal: 'right' };

    const overtimeHoursCell = row.getCell(7);
    overtimeHoursCell.value = toSafeFiniteNumber(item.overtime_hours);
    overtimeHoursCell.numFmt = HOURS_NUMBER_FORMAT;
    overtimeHoursCell.alignment = { vertical: 'middle', horizontal: 'right' };

    const sessionCountCell = row.getCell(8);
    sessionCountCell.value = toSafeFiniteNumber(item.session_count);
    sessionCountCell.numFmt = INTEGER_NUMBER_FORMAT;
    sessionCountCell.alignment = { vertical: 'middle', horizontal: 'right' };

    const statusText = item.status?.trim() ? item.status.trim() : 'Bình thường';
    const statusCell = row.getCell(9);
    setSafeStringCell(statusCell, statusText);
    statusCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    styleRowRange(worksheet, currentRowNumber, totalColumns, DATA_FONT);
  });

  const lastDataRowNumber = firstDataRowNumber + input.rows.length - 1;
  const totalRowNumber = lastDataRowNumber + 1;
  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.height = 25;

  worksheet.mergeCells(totalRowNumber, 1, totalRowNumber, 5);
  const totalLabelCell = totalRow.getCell(1);
  setSafeStringCell(totalLabelCell, 'TỔNG CỘNG');
  totalLabelCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // Công thức SUM cho tổng giờ công chuẩn (cột F)
  const totalWorkHours = input.rows.reduce((sum, r) => sum + toSafeFiniteNumber(r.work_hours), 0);
  const totalWorkHoursCell = totalRow.getCell(6);
  totalWorkHoursCell.value = {
    formula: `SUM(F${String(firstDataRowNumber)}:F${String(lastDataRowNumber)})`,
    result: Number(totalWorkHours.toFixed(2)),
  };
  totalWorkHoursCell.numFmt = HOURS_NUMBER_FORMAT;
  totalWorkHoursCell.alignment = { vertical: 'middle', horizontal: 'right' };

  // Công thức SUM cho tổng giờ tăng ca (cột G)
  const totalOvertimeHours = input.rows.reduce(
    (sum, r) => sum + toSafeFiniteNumber(r.overtime_hours),
    0,
  );
  const totalOvertimeCell = totalRow.getCell(7);
  totalOvertimeCell.value = {
    formula: `SUM(G${String(firstDataRowNumber)}:G${String(lastDataRowNumber)})`,
    result: Number(totalOvertimeHours.toFixed(2)),
  };
  totalOvertimeCell.numFmt = HOURS_NUMBER_FORMAT;
  totalOvertimeCell.alignment = { vertical: 'middle', horizontal: 'right' };

  // Công thức SUM cho tổng số ca chấm công (cột H)
  const totalSessions = input.rows.reduce(
    (sum, r) => sum + toSafeFiniteNumber(r.session_count),
    0,
  );
  const totalSessionsCell = totalRow.getCell(8);
  totalSessionsCell.value = {
    formula: `SUM(H${String(firstDataRowNumber)}:H${String(lastDataRowNumber)})`,
    result: totalSessions,
  };
  totalSessionsCell.numFmt = INTEGER_NUMBER_FORMAT;
  totalSessionsCell.alignment = { vertical: 'middle', horizontal: 'right' };

  setSafeStringCell(totalRow.getCell(9), '');

  styleRowRange(worksheet, totalRowNumber, totalColumns, TOTAL_FONT, TOTAL_ROW_FILL);

  worksheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: lastDataRowNumber, column: totalColumns },
  };

  const filename = `Bang_Cong_Chi_Nhanh_${sanitizedBranchToken}_${yearMonth}.xlsx`;
  await downloadWorkbookInBrowser(workbook, filename);
  return filename;
}
