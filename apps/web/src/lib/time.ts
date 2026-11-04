// Các hàm tiện ích làm tròn thời gian theo mốc 15 phút.

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export function roundUp15(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS);
}

export function roundDown15(date: Date): Date {
  return new Date(Math.floor(date.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS);
}
