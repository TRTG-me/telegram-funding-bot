import { Injectable, Logger } from '@nestjs/common';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { LighterService } from '../lighter/lighter.service';
import { ExtendedService } from '../extended/extended.service';
import { ITradingServices } from '../auto_trade/auto_trade.helpers';
import { AutoCloseSession } from './auto_close.session';

@Injectable()
export class AutoCloseService {
    private readonly logger = new Logger(AutoCloseService.name);
    private sessions = new Map<number, AutoCloseSession>();

    constructor(
        private binanceService: BinanceService,
        private hyperliquidService: HyperliquidService,
        private paradexService: ParadexService,
        private lighterService: LighterService,
        private extendedService: ExtendedService
    ) { }

    private get tradingServices(): ITradingServices {
        return {
            binance: this.binanceService,
            hl: this.hyperliquidService,
            paradex: this.paradexService,
            extended: this.extendedService,
            lighter: this.lighterService,
        };
    }

    public isRunning(userId: number): boolean {
        return this.sessions.has(userId);
    }

    public startSession(userId: number, notifyCallback: (msg: string) => Promise<void>) {
        if (this.sessions.has(userId)) {
            notifyCallback('⚠️ Мониторинг для вас уже запущен.');
            return;
        }

        const session = new AutoCloseSession(userId, this.tradingServices);
        this.sessions.set(userId, session);
        session.start(notifyCallback);
    }

    public stopSession(userId: number) {
        const session = this.sessions.get(userId);
        if (session) {
            session.stop();
            this.sessions.delete(userId);
        }
    }

    /**
     * Выполнить ручную проверку для конкретного пользователя.
     * Если есть активная сессия - используем её методы (но не стейт).
     * Если нет - создаем временную.
     */
    public async runManualCheck(userId: number): Promise<{ riskLogs: string[], adlLogs: string[] }> {
        let session = this.sessions.get(userId);

        // Если сессии нет, создаем временную (без запуска start())
        if (!session) {
            session = new AutoCloseSession(userId, this.tradingServices);
        }

        const { logs: riskLogs } = await session.checkAndReduceRisk();
        const { logs: adlLogs } = await session.checkAndFixHyperliquidADL();

        return { riskLogs, adlLogs };
    }
}