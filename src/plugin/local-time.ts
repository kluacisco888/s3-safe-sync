const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** 按本机时区显示为 HH:mm:ss（24 小时制） */
export const formatLocalClock = (value: number): string => {
  const date = new Date(value);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
};

/** 按本机时区显示为 YYYY-MM-DD HH:mm（withSeconds 时带秒）；无法解析时原样显示 */
export const formatLocalTime = (value: string | number, withSeconds = false): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const day = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  return withSeconds ? `${day} ${formatLocalClock(date.getTime())}` : `${day} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};
