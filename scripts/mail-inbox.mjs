import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (process.env.MAIL_MODE !== 'local' || !process.env.MAIL_OUTBOX_DIR || process.env.NODE_ENV === 'production') {
  console.error('本机测试收件箱未开启。'); process.exit(1);
}
const entries = await readdir(process.env.MAIL_OUTBOX_DIR).catch(() => []);
const mail = await Promise.all(entries.filter(name => /^[0-9a-f-]+\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(process.env.MAIL_OUTBOX_DIR, name), 'utf8'))));
mail.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
console.log('本机测试收件箱（没有向真实邮箱发送邮件）');
for (const item of mail.slice(0, 10)) console.log(`${item.createdAt}  ${item.email}  验证码：${item.code}`);
