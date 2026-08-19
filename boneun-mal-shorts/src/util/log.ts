import { env } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const l = env('LOG_LEVEL', 'info').toLowerCase() as Level;
  return ORDER[l] ?? ORDER.info;
}

function emit(level: Level, msg: string): void {
  if (ORDER[level] < threshold()) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${msg}\n`);
}

let totalSteps = 0;
let currentStep = 0;

export const log = {
  /** Declare how many top-level steps this run has, for `[n/total]` lines. */
  plan(total: number): void {
    totalSteps = total;
    currentStep = 0;
  },
  step(label: string): void {
    currentStep += 1;
    emit('info', `\n[${currentStep}/${totalSteps || '?'}] ${label}`);
  },
  info(msg: string): void {
    emit('info', `      ${msg}`);
  },
  ok(msg: string): void {
    emit('info', `      ✓ ${msg}`);
  },
  warn(msg: string): void {
    emit('warn', `      ⚠ ${msg}`);
  },
  error(msg: string): void {
    emit('error', `      ✗ ${msg}`);
  },
  debug(msg: string): void {
    emit('debug', `      · ${msg}`);
  },
  blank(): void {
    emit('info', '');
  },
  raw(msg: string): void {
    emit('info', msg);
  },
};
