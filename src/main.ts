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

// --- ИЗМЕНЕНИЕ 1: Добавляем новую строку с кнопками для тикера ---
const mainMenuKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги', 'bp'],
    ['Включить Alert', 'Выключить Alert', '✏️Изменить ранги'],
    ['🚀 Запустить тикер', '🛑 Остановить тикер'] // <--- НОВАЯ СТРОКА
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

    // --- 3. Регистрация команды /start ---
    bot.start((ctx) => {
        if (ctx.from) {
            userState.delete(ctx.from.id);
        }
        ctx.reply('Привет! Используйте меню внизу.', mainMenuKeyboard);
    });


    bot.on('callback_query', (ctx) => {
        bpController.handleCallbackQuery(ctx);
    });
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        if (bpController.isUserInBpFlow(userId)) {
            return bpController.handleCoinInput(ctx);
        }

        const currentState = userState.get(userId);
        const text = ctx.message.text;

        // --- ИЗМЕНЕНИЕ 2: Добавляем тексты новых кнопок в массив команд ---
        const mainMenuCommands = [
            'Плечи', 'Позиции', 'Фандинги',
            'Включить Alert', 'Выключить Alert', '✏️ Изменить ранги',
            '🚀 Запустить тикер', '🛑 Остановить тикер', 'bp' // <--- НОВЫЕ КОМАНДЫ
        ];

        // --- ЛОГИЧЕСКИЙ БЛОК 1: ПРИОРИТЕТНАЯ ОБРАБОТКА КОМАНД МЕНЮ ---
        if (mainMenuCommands.includes(text)) {
            userState.delete(userId);

            // --- ИЗМЕНЕНИЕ 3: Добавляем обработку новых кнопок в switch ---
            switch (text) {
                case 'Плечи':
                    return summaryController.sendSummaryTable(ctx);
                case 'Позиции':
                    return totalPositionsController.displayAggregatedPositions(ctx);
                case '✏️ Изменить ранги':
                    return rankingController.onUpdateRanksRequest(ctx);
                case 'Включить Alert':
                    return notificationController.startMonitoring(ctx);
                case 'Выключить Alert':
                    return notificationController.stopMonitoring(ctx);
                case 'Фандинги':
                    return totalFundingsController.displayHistoricalFunding(ctx);

                // --- НОВЫЕ ОБРАБОТЧИКИ ДЛЯ ТИКЕРА ---
                case '🚀 Запустить тикер':
                    return binanceTickerController.startTicker(ctx);
                case '🛑 Остановить тикер':
                    return binanceTickerController.stopTicker(ctx);
                case 'bp':
                    return bpController.handleBpCommand(ctx);
            }
        }
        // --- ЛОГИЧЕСКИЙ БЛОК 2: ОБРАБОТКА СОСТОЯНИЙ ---
        else if (currentState === 'awaiting_ranks_json') {
            return rankingController.onRanksJsonReceived(ctx);
        }
        // --- ЛОГИЧЕСКИЙ БЛОК 3: НЕИЗВЕСТНАЯ КОМАНДА ---
        else {
            ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
        }
    });

    // --- 5. Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен со всеми модулями!');
    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Начинаем завершение работы...`);
        notificationService.stopAllMonitors();
        bot.stop(signal);
        console.log('[Graceful Shutdown] Бот остановлен. Процесс завершается.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// Запускаем всю нашу асинхронную функцию
start();