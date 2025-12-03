import { Markup } from 'telegraf';
import { bot } from './core/bot';
import { message } from 'telegraf/filters';

// Импорт всех модулей
import { HyperliquidController } from './modules/hyperliquid/hyperliquid.controller';
import { HyperliquidService } from './modules/hyperliquid/hyperliquid.service';
import { BinanceController } from './modules/binance/binance.controller';
import { BinanceService } from './modules/binance/binance.service';
import { ParadexController } from './modules/paradex/paradex.controller';
import { ParadexService } from './modules/paradex/paradex.service';
import { LighterController } from './modules/lighter/lighter.controller';
import { LighterService } from './modules/lighter/lighter.service';
import { NotificationService } from './modules/notifications/notification.service';
import { NotificationController } from './modules/notifications/notification.controller';
import { ExtendedController } from './modules/extended/extended.controller';
import { ExtendedService } from './modules/extended/extended.service';
import { RankingService } from './modules/ranking/ranking.service';
import { RankingController } from './modules/ranking/ranking.controller';
import { SummaryController } from './modules/summary/summary.controller';
import { SummaryService } from './modules/summary/summary.service';
import { TotalPositionsController } from './modules/totalPositions/totalPositions.controller';
import { TotalPositionsService } from './modules/totalPositions/totalPositions.service';
import { TotalFundingsController } from './modules/totalFundings/totalFundings.controller';
import { TotalFundingsService } from './modules/totalFundings/totalFundings.service';
import { BinTradeController } from './modules/bin_trade/bin_trade.controller';
import { HypeTradeController } from './modules/hl_trade/hl_trade.controller';

import { BinanceTickerService } from './modules/binance/websocket/binance.ticker.service';
import { BinanceTickerController } from './modules/binance/websocket/binance.ticker.controller';

import { HyperliquidTickerService } from './modules/hyperliquid/websocket/hyperliquid.ticker.service';
import { HyperliquidTickerController } from './modules/hyperliquid/websocket/hyperliquid.ticker.controller';

import { ParadexTickerService } from './modules/paradex/websocket/paradex.ticker.service';
import { ParadexTickerController } from './modules/paradex/websocket/paradex.ticker.controller';

import { ExtendedTickerService } from './modules/extended/websocket/extended.ticker.service';
import { ExtendedTickerController } from './modules/extended/websocket/extended.ticker.controller';

import { LighterTickerService } from './modules/lighter/websocket/lighter.ticker.service';
import { LighterTickerController } from './modules/lighter/websocket/lighter.ticker.controller';

import { BpService } from './modules/bp/bp.service';
import { BpController } from './modules/bp/bp.controller';

// --- NEW: Импорты AutoTrade ---
import { AutoTradeService } from './modules/auto_trade/auto_trade.service';
import { AutoTradeController } from './modules/auto_trade/auto_trade.controller';

// --- ИЗМЕНЕНИЕ: Добавляем 'OPEN POS' в клавиатуру ---
const mainMenuKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги', 'bp', 'OPEN POS'], // <-- Trade заменил на OPEN POS (или добавил рядом)
    ['Включить Alert', 'Выключить Alert', '✏️Изменить ранги'],
    ['🚀 Запустить тикер', '🛑 Остановить тикер']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // --- 1. Инициализация всех СЕРВИСОВ ---
    const binanceService = new BinanceService();
    const hyperliquidService = new HyperliquidService();
    const paradexService = new ParadexService();
    const lighterService = new LighterService();
    const extendedService = new ExtendedService();
    const rankingService = new RankingService();
    const binanceTickerService = new BinanceTickerService();
    const hyperliquidTickerService = new HyperliquidTickerService();
    const paradexTickerService = new ParadexTickerService();
    const extendedTickerService = new ExtendedTickerService();
    const lighterTickerService = new LighterTickerService();

    const bpService = new BpService(
        binanceTickerService,
        hyperliquidTickerService,
        paradexTickerService,
        extendedTickerService,
        lighterTickerService
    );

    // --- NEW: Инициализация AutoTradeService ---
    const autoTradeService = new AutoTradeService(
        binanceTickerService,
        hyperliquidTickerService,
        // парадекс и остальные, если вы их добавили в конструктор сервиса
        // paradexTickerService, ...

        binanceService,
        hyperliquidService,
        // ...
    );


    // Сервисы-агрегаторы
    const summaryService = new SummaryService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );
    const totalPositionsService = new TotalPositionsService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );
    const notificationService = new NotificationService(
        bot, binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );

    const totalFundingsService = new TotalFundingsService(
        totalPositionsService
    );


    // --- 2. Инициализация всех КОНТРОЛЛЕРОВ ---
    const hyperliquidController = new HyperliquidController(hyperliquidService, userState);
    const binanceController = new BinanceController(binanceService, userState);
    const paradexController = new ParadexController(paradexService, userState);
    const lighterController = new LighterController(lighterService, userState);
    const extendedController = new ExtendedController(extendedService, userState);
    const rankingController = new RankingController(rankingService, userState);
    const summaryController = new SummaryController(summaryService);
    const totalPositionsController = new TotalPositionsController(totalPositionsService);
    const notificationController = new NotificationController(notificationService);
    const totalFundingsController = new TotalFundingsController(totalFundingsService);
    const binanceTickerController = new BinanceTickerController(binanceTickerService);
    const hyperliquidTickerController = new HyperliquidTickerController(hyperliquidTickerService);
    const paradexTickerController = new ParadexTickerController(paradexTickerService)
    const extendedTickerController = new ExtendedTickerController(extendedTickerService);
    const lighterTickerController = new LighterTickerController(lighterTickerService);
    const bpController = new BpController(bpService);

    const binTradeController = new BinTradeController(binanceService); // Можно оставить если нужно
    // const hypeTradeController = new HypeTradeController(hyperliquidService); // Можно оставить

    // --- NEW: Инициализация AutoTradeController ---
    const autoTradeController = new AutoTradeController(autoTradeService);

    // --- 3. Регистрация команды /start ---
    bot.start((ctx) => {
        if (ctx.from) {
            userState.delete(ctx.from.id);
        }
        ctx.reply('Привет! Используйте меню внизу.', mainMenuKeyboard);
    });

    // --- 4. Обработчик Callback Query (кнопок) ---
    bot.on('callback_query', (ctx) => {
        // Проверяем, кто должен обработать callback
        const data = (ctx.callbackQuery as any).data;

        // Если это кнопки BP контроллера
        if (data && data.startsWith('bp_')) {
            return bpController.handleCallbackQuery(ctx);
        }

        // --- NEW: Если это кнопки AutoTrade (at_ или stop_autotrade) ---
        if (data && (data.startsWith('at_') || data === 'stop_autotrade')) {
            return autoTradeController.handleCallback(ctx);
        }

        // Другие колбеки...
    });

    // --- 5. Обработчик Текста ---
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        const text = ctx.message.text;

        // =================================================================
        // 1. СНАЧАЛА ПРОВЕРЯЕМ ГЛОБАЛЬНЫЕ КОМАНДЫ (КНОПКИ МЕНЮ)
        // =================================================================
        const mainMenuCommands = [
            'Плечи', 'Позиции', 'Фандинги',
            'Включить Alert', 'Выключить Alert', '✏️ Изменить ранги',
            '🚀 Запустить тикер', '🛑 Остановить тикер', 'bp',
            'OPEN POS'
        ];

        if (mainMenuCommands.includes(text)) {
            // Если нажали любую кнопку меню - мы СБРАСЫВАЕМ старые стейты
            // Это позволяет выйти из любого зависшего ввода
            userState.delete(userId);
            // Обратите внимание: мы НЕ удаляем стейт AutoTrade тут вручную, 
            // потому что handleOpenPosCommand сам решит, что делать (стопать или ресетить)

            switch (text) {
                // ... ваши старые кейсы ...
                case 'Плечи': return summaryController.sendSummaryTable(ctx);
                case 'Позиции': return totalPositionsController.displayAggregatedPositions(ctx);
                // ...
                case 'bp': return bpController.handleBpCommand(ctx);

                // ГЛАВНОЕ:
                case 'OPEN POS':
                    return autoTradeController.handleOpenPosCommand(ctx);
            }
            return; // Важно: выходим, чтобы не попасть в блоки ниже
        }

        // =================================================================
        // 2. ПОТОМ ПРОВЕРЯЕМ, ЖДЕМ ЛИ МЫ ВВОДА (AutoTrade, BP и т.д.)
        // =================================================================

        // Если юзер вводит данные для AutoTrade (название, кол-во...)
        if (autoTradeController.isUserInFlow(userId)) {
            return autoTradeController.handleInput(ctx);
        }

        // Если юзер вводит данные для BP
        if (bpController.isUserInBpFlow(userId)) {
            return bpController.handleCoinInput(ctx);
        }

        // =================================================================
        // 3. ОБРАБОТКА ДРУГИХ СТЕЙТОВ (Ранги и т.д.)
        // =================================================================
        const currentState = userState.get(userId);

        if (currentState === 'awaiting_ranks_json') {
            return rankingController.onRanksJsonReceived(ctx);
        }
        else {
            ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
        }
    });

    // --- 6. Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен со всеми модулями!');
    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Начинаем завершение работы...`);
        notificationService.stopAllMonitors();
        // Можно добавить остановку всех трейд-сессий
        // autoTradeService.stopAllSessions();
        bot.stop(signal);
        console.log('[Graceful Shutdown] Бот остановлен. Процесс завершается.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start();