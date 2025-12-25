import * as fs from 'fs';
import * as path from 'path';

export class CriticalLogger {
    private static readonly logFile = path.join(process.cwd(), 'critical_errors.log');

    public static log(event: string, details: any) {
        const timestamp = new Date().toISOString();
        const logEntry = JSON.stringify({ timestamp, event, ...details }) + '\n';

        try {
            fs.appendFileSync(this.logFile, logEntry);
        } catch (e) {
            console.error('FAILED TO WRITE TO CRITICAL LOG:', e);
        }
    }
}
