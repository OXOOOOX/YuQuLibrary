import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import nodemailer from 'nodemailer';
import type { DeliverCode } from '@yuqu/domain/auth';

export const deliverCode: DeliverCode = async message => {
  if (process.env.MAIL_MODE === 'local') {
    const directory = process.env.MAIL_OUTBOX_DIR;
    if (process.env.NODE_ENV === 'production' || !directory || !isAbsolute(directory)) throw new Error('Local mail is unavailable');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${message.challengeId}.json`), JSON.stringify({ ...message, createdAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return 'local';
  }
  if (process.env.MAIL_MODE !== 'smtp' || !process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) throw new Error('SMTP is not configured');
  const port = Number(process.env.SMTP_PORT || 587);
  if (![465, 587, 2525].includes(port)) throw new Error('Invalid SMTP port');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true
  });
  const result = await transport.sendMail({ from: process.env.SMTP_FROM, to: message.email,
    subject: '鱼趣知识库登录验证码',
    text: `你的鱼趣知识库登录验证码是 ${message.code}，10 分钟内有效。如果不是你本人操作，请忽略本邮件。` });
  if (!result.accepted.length) throw new Error('Delivery rejected');
  return 'smtp';
};
