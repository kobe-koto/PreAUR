import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pc from "picocolors";

let sessionLogDir = '';

export const loggerContext = new AsyncLocalStorage<fs.WriteStream>();

function formatTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');

    const yyyy = d.getFullYear();
    const mo = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());

    return `${yyyy}-${mo}-${dd}_${hh}-${mm}`;
}

export function initMainLogger(baseDir: string = process.cwd()) {
    const logsBaseDir = path.join(baseDir, 'logs');
    if (!fs.existsSync(logsBaseDir)) {
        fs.mkdirSync(logsBaseDir, { recursive: true });
    }

    sessionLogDir = path.join(logsBaseDir, formatTimestamp());
    if (!fs.existsSync(sessionLogDir)) {
        fs.mkdirSync(sessionLogDir, { recursive: true });
    }

    const mainLogFile = path.join(sessionLogDir, 'main.log');
    const mainStream = fs.createWriteStream(mainLogFile, { flags: 'a' });

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args: any[]) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const taskStream = loggerContext.getStore();
        if (taskStream) {
            taskStream.write(msg + '\n');
        }
        if (process.stdout.isTTY || !taskStream) {
            originalLog(msg);
        }
        mainStream.write(msg + '\n');
    };

    console.error = (...args: any[]) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const taskStream = loggerContext.getStore();
        if (taskStream) {
            taskStream.write(msg + '\n');
        }
        if (process.stdout.isTTY || !taskStream) {
            originalError(msg);
        }
        mainStream.write(msg + '\n');
    };

    console.warn = (...args: any[]) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const taskStream = loggerContext.getStore();
        if (taskStream) {
            taskStream.write(msg + '\n');
        }
        if (process.stdout.isTTY || !taskStream) {
            originalWarn(msg);
        }
        mainStream.write(msg + '\n');
    };

    console.log(`[Logger] Session initialized at ${sessionLogDir}`);
}

export function getSessionLogDir(): string {
    if (!sessionLogDir) {
        throw new Error('Logger not initialized. Call initMainLogger() first.');
    }
    return sessionLogDir;
}

export function getTaskLogPath(pkgname: string): string {
    const taskLogDir = path.join(getSessionLogDir(), pkgname);
    return path.join(taskLogDir, 'main.log');
}

export function createTaskLogger(pkgname: string): fs.WriteStream {
    const logFile = getTaskLogPath(pkgname);
    const taskLogDir = path.dirname(logFile);
    if (!fs.existsSync(taskLogDir)) {
        fs.mkdirSync(taskLogDir, { recursive: true });
    }
    return fs.createWriteStream(logFile, { flags: 'a' });
}

export function constructMessager (category: string, subcategory?: string): (message: string) => string {
    return (message) => (
        subcategory ?
        `${pc.magenta(`[${category}]`)} ${pc.blue(`[${subcategory}]`)} ${message}` :
        `${pc.magenta(`[${category}]`)} ${message}`
    );
}
