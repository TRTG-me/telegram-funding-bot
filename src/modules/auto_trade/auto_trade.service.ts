import { Injectable, Logger } from '@nestjs/common';
import { AutoTradeSession } from './auto_trade.session';
// Берем типы из специального файла (разорвали круг зависимостей)
import { TradeSessionConfig } from './auto_trade.types';
import { ITradingServices } from './auto_trade.helpers';


// Импорт REST сервисов (они нужны для передачи в сессию)
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { ExtendedService } from '../extended/extended.service';
import { LighterService } from '../lighter/lighter.service';


@Injectable()
export class AutoTradeService {
    private readonly logger = new Logger(AutoTradeService.name);

    // Хранилище сессий: UserId -> Session
    private sessions = new Map<number, AutoTradeSession>();

    constructor(
        private binanceService: BinanceService,
        private hlService: HyperliquidService,
        private paradexService: ParadexService,
        private extendedService: ExtendedService,
        private lighterService: LighterService
    ) { }

    // Собираем сервисы в объект для передачи
    private get tradingServices(): ITradingServices {
        return {
            binance: this.binanceService,
            hl: this.hlService,
            paradex: this.paradexService,
            extended: this.extendedService,
            lighter: this.lighterService,
        };
    }

    public isRunning(userId: number): boolean {
        return this.sessions.has(userId);
    }

    public async startSession(config: TradeSessionConfig) {
        const { userId } = config;

        // Если сессия уже есть - останавливаем
        this.stopSession(userId, 'New Session Started');

        const session = new AutoTradeSession(
            config,
            this.tradingServices, // Передаем REST сервисы
            this.lighterService   // Передаем Data сервис
        );

        this.sessions.set(userId, session);

        try {
            await session.start();
        } catch (e) {
            // Ошибка уже залогирована внутри
        } finally {
            // ✅ ВАЖНО: Удаляем сессию после завершения (успешного или с ошибкой)
            if (this.sessions.get(userId) === session) {
                this.sessions.delete(userId);
            }
        }
    }

    public stopSession(userId: number, reason: string = 'Unknown') {
        const session = this.sessions.get(userId);
        if (session) {
            session.stop(reason);
            this.sessions.delete(userId);
            this.logger.log(`Stopped session for user ${userId}: ${reason}`);
        }
    }
}