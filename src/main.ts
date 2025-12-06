import { Markup } from 'telegraf';
import { bot } from './core/bot';
import { message } from 'telegraf/filters';

// --- Services ---
import { BinanceService } from './modules/binance/binance.service';
import { HyperliquidService } from './modules/hyperliquid/hyperliquid.service';
import { ParadexService } from './modules/paradex/paradex.service';
import { LighterService } from './modules/lighter/lighter.service';
import { ExtendedService } from './modules/extended/extended.service';

// --- Ticker Services ---
import { BinanceTickerService } from './modules/binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from './modules/hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from './modules/paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from './modules/extended/websocket/extended.ticker.service';
import { LighterTickerService } from './modules/lighter/websocket/lighter.ticker.service';

// --- Aggregator Services ---
import { RankingService } from './modules/ranking/ranking.service';
import { SummaryService } from './modules/summary/summary.service';
import { TotalPositionsService } from './modules/totalPositions/totalPositions.service';
import { TotalFundingsService } from './modules/totalFundings/totalFundings.service';
import { NotificationService } from './modules/notifications/notification.service';
import { BpService } from './modules/bp/bp.service';
import { AutoTradeService } from './modules/auto_trade/auto_trade.service';

// --- Controllers ---
import { RankingController } from './modules/ranking/ranking.controller';
import { SummaryController } from './modules/summary/summary.controller';
import { TotalPositionsController } from './modules/totalPositions/totalPositions.controller';
import { TotalFundingsController } from './modules/totalFundings/totalFundings.controller';
import { NotificationController } from './modules/notifications/notification.controller';
import { BinanceTickerController } from './modules/binance/websocket/binance.ticker.controller';
import { BpController } from './modules/bp/bp.controller';
import { AutoTradeController } from './modules/auto_trade/auto_trade.controller';

// --- Keyboard ---
const mainMenuKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги', 'bp', 'OPEN POS'],
    ['Включить Alert', 'Выключить Alert', '✏️Изменить ранги'],
    ['🚀 Запустить тикер', '🛑 Остановить тикер']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // ============================================================
    // 1. ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ (СЛОЙ ДАННЫХ)
    // ============================================================

    // Базовые сервисы бирж
    const binanceService = new BinanceService();
    const hyperliquidService = new HyperliquidService();
    const paradexService = new ParadexService();
    const lighterService = new LighterService();
    const extendedService = new ExtendedService();

    // Веб-сокет тикеры
    const binanceTickerService = new BinanceTickerService();
    const hyperliquidTickerService = new HyperliquidTickerService();
    const paradexTickerService = new ParadexTickerService();
    const extendedTickerService = new ExtendedTickerService();
    const lighterTickerService = new LighterTickerService();

    // Сервисы бизнес-логики
    const rankingService = new RankingService();

    const summaryService = new SummaryService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );

    const totalPositionsService = new TotalPositionsService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );

    const totalFundingsService = new TotalFundingsService(
        totalPositionsService
    );

    const notificationService = new NotificationService(
        bot, binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );

    const bpService = new BpService(
        binanceTickerService,
        hyperliquidTickerService,
        paradexTickerService,
        extendedTickerService,
        lighterTickerService
    );

    const autoTradeService = new AutoTradeService(
        binanceTickerService,
        hyperliquidTickerService,
        paradexTickerService,
        binanceService,
        hyperliquidService,
        paradexService
    );

    // ============================================================
    // 2. ИНИЦИАЛИЗАЦИЯ КОНТРОЛЛЕРОВ (СЛОЙ ВЗАИМОДЕЙСТВИЯ)
    // ============================================================

    const rankingController = new RankingController(rankingService, userState);
    const summaryController = new SummaryController(summaryService);
    const totalPositionsController = new TotalPositionsController(totalPositionsService);
    const totalFundingsController = new TotalFundingsController(totalFundingsService);
    const notificationController = new NotificationController(notificationService);
    const binanceTickerController = new BinanceTickerController(binanceTickerService);
    const bpController = new BpController(bpService);
    const autoTradeController = new AutoTradeController(autoTradeService);

    // ============================================================
    // 3. ОБРАБОТЧИКИ TELEGRAM
    // ============================================================

    bot.start((ctx) => {
        if (ctx.from) {
            userState.delete(ctx.from.id);
        }
        ctx.reply('Привет! Используйте меню внизу.', mainMenuKeyboard);
    });

    // Обработка кнопок (Inline)
    bot.on('callback_query', (ctx) => {
        const data = (ctx.callbackQuery as any).data;

        if (data && data.startsWith('bp_')) {
            return bpController.handleCallbackQuery(ctx);
        }

        if (data && (data.startsWith('at_') || data === 'stop_autotrade')) {
            return autoTradeController.handleCallback(ctx);
        }
    });

    // Обработка текста
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        const text = ctx.message.text;

        // --- ЛОГИКА 1: ПРИОРИТЕТНАЯ ОБРАБОТКА МЕНЮ ---
        const mainMenuCommands = [
            'Плечи', 'Позиции', 'Фандинги',
            'Включить Alert', 'Выключить Alert', '✏️ Изменить ранги',
            '🚀 Запустить тикер', '🛑 Остановить тикер', 'bp',
            'OPEN POS'
        ];

        if (mainMenuCommands.includes(text)) {
            userState.delete(userId); // Сброс состояний рангов

            switch (text) {
                case 'Плечи':
                    return summaryController.sendSummaryTable(ctx);
                case 'Позиции':
                    return totalPositionsController.displayAggregatedPositions(ctx);
                case 'Фандинги':
                    return totalFundingsController.displayHistoricalFunding(ctx);
                case '✏️ Изменить ранги':
                    return rankingController.onUpdateRanksRequest(ctx);
                case 'Включить Alert':
                    return notificationController.startMonitoring(ctx);
                case 'Выключить Alert':
                    return notificationController.stopMonitoring(ctx);
                case '🚀 Запустить тикер':
                    return binanceTickerController.startTicker(ctx);
                case '🛑 Остановить тикер':
                    return binanceTickerController.stopTicker(ctx);
                case 'bp':
                    return bpController.handleBpCommand(ctx);
                case 'OPEN POS':
                    return autoTradeController.handleOpenPosCommand(ctx);
            }
            return;
        }

        // --- ЛОГИКА 2: ВВОД ДАННЫХ ДЛЯ СЕРВИСОВ ---

        // AutoTrade Flow
        if (autoTradeController.isUserInFlow(userId)) {
            return autoTradeController.handleInput(ctx);
        }

        // BP Flow
        if (bpController.isUserInBpFlow(userId)) {
            return bpController.handleCoinInput(ctx);
        }

        // --- ЛОГИКА 3: ДРУГИЕ СОСТОЯНИЯ ---
        const currentState = userState.get(userId);

        if (currentState === 'awaiting_ranks_json') {
            return rankingController.onRanksJsonReceived(ctx);
        }
        else {
            ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
        }
    });

    // ============================================================
    // 4. ЗАПУСК
    // ============================================================
    await bot.launch();
    console.log('✅ Бот успешно запущен со всеми модулями!');

    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Завершение...`);
        notificationService.stopAllMonitors();
        // При желании можно остановить все сессии автотрейда
        // autoTradeService.stopAllSessions(); 
        bot.stop(signal);
        console.log('[Graceful Shutdown] Готово.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start();