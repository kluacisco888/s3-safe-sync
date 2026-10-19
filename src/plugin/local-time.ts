const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** 按本机时区显示为 YYYY-MM-DD HH:mm；无法解析时原样显示 */
export const formatLocalTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};
