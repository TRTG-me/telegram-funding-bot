import { Injectable, Logger } from '@nestjs/common';
import { LighterService } from '../lighter/lighter.service';
import { FundingApiService } from '../funding_api/funding_api.service';
import { PayBackSession } from './payback.session';
import { ExchangeName } from '../bp/bp.types';
import { PayBackResult } from './payback.types';

const EXCHANGE_MAP: Record<string, ExchangeName> = {
    'B': 'Binance',
    'H': 'Hyperliquid',
    'P': 'Paradex',
    'L': 'Lighter',
    'E': 'Extended'
};

@Injectable()
export class PayBackService {
    private readonly logger = new Logger(PayBackService.name);
    private sessions = new Map<number, PayBackSession | PayBackSession[]>();

    constructor(
        private readonly lighterDataService: LighterService,
        private readonly fundingApiService: FundingApiService
    ) { }

    public async startTestSession(
        userId: number,
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onFinished: (result: PayBackResult | null) => void
    ): Promise<void> {
        this.stopSession(userId);

        const session = new PayBackSession(userId, this.lighterDataService, this.fundingApiService);
        this.sessions.set(userId, session);

        try {
            await session.start(coin, longExchange, shortExchange, (result) => {
                this.sessions.delete(userId);
                onFinished(result);
            });
        } catch (e) {
            this.sessions.delete(userId);
            throw e;
        }
    }

    public async startDeepScan(userId: number, onFinished: (result: string) => void): Promise<void> {
        this.stopSession(userId);

        try {
            const best = await this.fundingApiService.getBestOpportunities();
            const top = best.slice(0, 25);

            if (top.length === 0) {
                onFinished('📭 Не удалось найти лучшие монеты для глубокого анализа.');
                return;
            }

            const sessions: PayBackSession[] = [];
            this.sessions.set(userId, sessions);

            const pendingResults: (PayBackResult | null)[] = new Array(top.length).fill(null);
            let finishedCount = 0;

            const checkFinished = async () => {
                finishedCount++;
                if (finishedCount === top.length) {
                    this.sessions.delete(userId);
                    onFinished(this.formatDeepScanTable(top, pendingResults));
                }
            };

            for (let i = 0; i < top.length; i++) {
                const item = top[i];
                const parts = item.pair.split('-');
                const longEx = EXCHANGE_MAP[parts[0]];
                const shortEx = EXCHANGE_MAP[parts[1]];

                if (!longEx || !shortEx) {
                    finishedCount++;
                    continue;
                }

                await new Promise(r => setTimeout(r, 500));

                const session = new PayBackSession(userId, this.lighterDataService, this.fundingApiService);
                sessions.push(session);

                session.start(item.coin, longEx, shortEx, (res) => {
                    pendingResults[i] = res;
                    checkFinished();
                }).catch(() => checkFinished());
            }

        } catch (err: any) {
            this.sessions.delete(userId);
            throw err;
        }
    }

    private formatDeepScanTable(originalItems: any[], results: (PayBackResult | null)[]): string {
        const c0 = 12; // COIN (P)
        const cW = 5;  // DATA
        const cP = 6;  // P.DAY

        let table = '📊 <b>DEEP SCAN (TOP-25)</b>\n<pre><code>';
        table += `┌${'─'.repeat(c0)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cP)}┐\n`;
        table += `│${'COIN (P)'.padEnd(c0)}│${'8h'.padStart(cW)}│${'1d'.padStart(cW)}│${'3d'.padStart(cW)}│${'7d'.padStart(cW)}│${'14d'.padStart(cW)}│${'P.DAY'.padStart(cP)}│\n`;
        table += `├${'─'.repeat(c0)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cP)}┤\n`;

        originalItems.forEach((item, i) => {
            const res = results[i];
            const label = `${item.coin} (${item.pair})`.substring(0, c0).padEnd(c0);
            const diffs = item.diffs.map((v: number) => v.toFixed(0).padStart(cW)).join('│');

            let pbStr = '  --- ';
            if (res) {
                if (res.dailyReturnBp <= 0) pbStr = ' NEVER';
                else if (res.totalCostBp <= 0) pbStr = '   0.0';
                else pbStr = res.paybackDays.toFixed(1).padStart(cP);
            }

            table += `│${label}│${diffs}│${pbStr.padStart(cP)}│\n`;
        });

        table += `└${'─'.repeat(c0)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cP)}┘\n`;
        table += '</code></pre>';
        table += '\n<i>P.DAY: Окупаемость (Comm+BP) / Daily Worst Diffs.</i>';
        return table;
    }

    public stopSession(userId: number): void {
        const item = this.sessions.get(userId);
        if (item) {
            if (Array.isArray(item)) {
                item.forEach(s => s.stop());
            } else {
                item.stop();
            }
            this.sessions.delete(userId);
        }
    }

    public isSessionActive(userId: number): boolean {
        return this.sessions.has(userId);
    }

    public stopAll() {
        for (const userId of this.sessions.keys()) {
            this.stopSession(userId);
        }
    }
}
