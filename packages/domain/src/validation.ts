import { AppError } from './errors.ts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function invalid(message = '请求内容无效，请检查后重试。'): AppError {
  return new AppError(400, 'INVALID_INPUT', message);
}
export function emailAddress(value: unknown): string {
  if (typeof value !== 'string') throw invalid('请输入有效邮箱。');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) throw invalid('请输入有效邮箱。');
  return email;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw invalid();
  return value.toLowerCase();
}
export function integer(value: unknown, min = 0, max = 2_147_483_646): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
