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
import { AutoCloseService } from './modules/auto_close/auto_close.service';

// --- Controllers ---
import { RankingController } from './modules/ranking/ranking.controller';
import { SummaryController } from './modules/summary/summary.controller';
import { TotalPositionsController } from './modules/totalPositions/totalPositions.controller';
import { TotalFundingsController } from './modules/totalFundings/totalFundings.controller';
import { NotificationController } from './modules/notifications/notification.controller';
import { BinanceTickerController } from './modules/binance/websocket/binance.ticker.controller';
import { BpController } from './modules/bp/bp.controller';
import { AutoTradeController } from './modules/auto_trade/auto_trade.controller';
import { ExtendedTradeController } from './modules/extended/extended.trade.controller';
import { LighterController } from './modules/lighter/lighter.controller';
import { AutoCloseController } from './modules/auto_close/auto_close.controller';

// ============================================================
// ГЛОБАЛЬНАЯ ЗАЩИТА (ЧТОБЫ НЕ ПАДАЛО ПРИ ОШИБКАХ СЕТИ)
// ============================================================

// 1. Необработанные исключения (например, axios timeout вне try-catch)
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
    // Если ошибка связана с сетью/сокетами, игнорируем и живем дальше
    if (err.message.includes('ETIMEDOUT') ||
        err.message.includes('socket hang up') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('getaddrinfo') ||
        err.message.includes('FetchError')) {
        console.log('⚠️ Network glitch detected. Process will continue.');
        return;
    }
    // В других случаях PM2 перезапустит процесс, но для трейд-бота 
    // мы стараемся выжить любой ценой, чтобы сохранить стейт.
});

// 2. Необработанные промисы (часто бывают при дисконнектах базы или API)
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
    // Просто логируем, не роняем процесс
});

// ============================================================

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
        lighterTickerService,
        lighterService
    );

    const autoTradeService = new AutoTradeService(
        binanceTickerService,
        hyperliquidTickerService,
        paradexTickerService,
        extendedTickerService,
        lighterTickerService,
        binanceService,
        hyperliquidService,
        paradexService,
        extendedService,
        lighterService
    );
    const autoCloseService = new AutoCloseService(
        binanceService,
        hyperliquidService,
        paradexService,
        lighterService,
        extendedService
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
    const extendedTradeController = new ExtendedTradeController(extendedService);
    const lighterController = new LighterController(lighterService);
    const autoCloseController = new AutoCloseController(autoCloseService);

    // ============================================================
    // 3. ОБРАБОТЧИКИ TELEGRAM
    // ============================================================

    // Перехват ошибок Telegraf (чтобы бот не падал при сбоях отправки сообщений)
    bot.catch((err: any, ctx: any) => {
        console.error(`❌ Telegraf Error for ${ctx.updateType}:`, err.message);
    });

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
            'Включить Alert', 'Выключить Alert', '✏️Изменить ранги',
            '🚀 Запустить тикер', '🛑 Остановить тикер', 'bp',
            'OPEN POS'
        ];

        // Обратите внимание: текст должен точно совпадать (в вашем коде было '✏️ Изменить ранги' vs '✏️Изменить ранги')
        // Я унифицировал список выше.

        if (mainMenuCommands.includes(text) || text === '✏️ Изменить ранги') { // на всякий случай оба варианта
            userState.delete(userId); // Сброс состояний рангов

            switch (text) {
                case 'Плечи':
                    return summaryController.sendSummaryTable(ctx);
                case 'Позиции':
                    return totalPositionsController.displayAggregatedPositions(ctx);
                case 'Фандинги':
                    return totalFundingsController.displayHistoricalFunding(ctx);
                case '✏️ Изменить ранги':
                case '✏️Изменить ранги':
                    return rankingController.onUpdateRanksRequest(ctx);
                case 'Включить Alert':
                    return notificationController.startMonitoring(ctx);
                case 'Выключить Alert':
                    return notificationController.stopMonitoring(ctx);
                case '🚀 Запустить тикер':
                    //return binanceTickerController.startTicker(ctx);
                    return autoCloseController.handleManualCheck(ctx);
                case '🛑 Остановить тикер':
                    return binanceTickerController.stopTicker(ctx);
                case 'bp':
                    return bpController.handleBpCommand(ctx);
                case 'OPEN POS':
                    // Сейчас стоит Lighter Test. Когда будете готовы, раскомментируйте AutoTrade.                   
                    return autoTradeController.handleOpenPosCommand(ctx);
                //return autoCloseController.handleManualCheck(ctx);

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

    // Оборачиваем launch в try-catch для защиты при старте
    try {
        await bot.launch();
        console.log('✅ Бот успешно запущен со всеми модулями!');
    } catch (err: any) {
        console.error('❌ Ошибка запуска бота (проверьте интернет/токен):', err.message);
        // Не выходим, PM2 или retry логика может помочь, но здесь просто лог
    }

    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Завершение...`);
        notificationService.stopAllMonitors();
        // Можно добавить: bpService.stop(), autoTradeService.stopSession()...
        bot.stop(signal);
        console.log('[Graceful Shutdown] Готово.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start();