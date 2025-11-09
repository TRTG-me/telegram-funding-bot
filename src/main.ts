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


// --- Клавиатура и управление состоянием ---
const mainMenuKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги'],
    ['Включить Alert', 'Выключить Alert', '✏️Изменить ранги']
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

    // --- 3. Регистрация команды /start ---
    bot.start((ctx) => {
        if (ctx.from) {
            userState.delete(ctx.from.id);
        }
        ctx.reply('Привет! Используйте меню внизу.', mainMenuKeyboard);
    });

    // --- 4. Главный обработчик текстовых сообщений (ИСПРАВЛЕННАЯ ЛОГИКА) ---
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        const currentState = userState.get(userId);
        const text = ctx.message.text;

        const mainMenuCommands = ['Плечи', 'Позиции', '✏️ Изменить ранги', 'Включить Alert', 'Выключить Alert', 'Фандинги'];

        // --- ЛОГИЧЕСКИЙ БЛОК 1: ПРИОРИТЕТНАЯ ОБРАБОТКА КОМАНД МЕНЮ ---
        // Сначала проверяем, является ли сообщение командой из главного меню.
        if (mainMenuCommands.includes(text)) {
            // Если это команда, мы ОБЯЗАТЕЛЬНО сбрасываем любое предыдущее состояние.
            userState.delete(userId);

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

            }
        }
        // --- ЛОГИЧЕСКИЙ БЛОК 2: ОБРАБОТКА СОСТОЯНИЙ ---
        // Этот блок выполнится, только если сообщение НЕ является командой из меню.
        else if (currentState === 'awaiting_ranks_json') {
            return rankingController.onRanksJsonReceived(ctx);
        }
        // --- ЛОГИЧЕСКИЙ БЛОК 3: НЕИЗВЕСТНАЯ КОМАНДА ---
        // Этот блок выполнится, только если сообщение не является ни командой, ни вводом для состояния.
        else {
            ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
        }
    });

    // --- 5. Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен со всеми модулями!');
    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Начинаем завершение работы...`);

        // 1. Останавливаем все активные таймеры мониторинга
        notificationService.stopAllMonitors();

        // 2. Останавливаем сам бот (он перестает получать новые сообщения)
        bot.stop(signal);

        console.log('[Graceful Shutdown] Бот остановлен. Процесс завершается.');

        // 3. Завершаем процесс Node.js
        process.exit(0);
    };

    // Слушаем системные сигналы на завершение
    // SIGINT - это сигнал, который отправляется при нажатии Ctrl+C
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // SIGTERM - это стандартный сигнал для "вежливого" завершения процесса
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// Запускаем всю нашу асинхронную функцию
start();