import * as fs from 'node:fs';
import * as path from 'node:path';

let sessionLogDir = '';

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
        originalLog(msg);
        mainStream.write(msg + '\n');
    };

    console.error = (...args: any[]) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        originalError(msg);
        mainStream.write(msg + '\n');
    };

    console.warn = (...args: any[]) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        originalWarn(msg);
        mainStream.write(msg + '\n');
    };

    console.log(`[Logger] Session initialized at ${sessionLogDir}`);
}

export function createTaskLogger(pkgname: string): fs.WriteStream {
    if (!sessionLogDir) {
        throw new Error('Logger not initialized. Call initMainLogger() first.');
    }
    const logFile = path.join(sessionLogDir, `${pkgname}.log`);
    return fs.createWriteStream(logFile, { flags: 'a' });
}
