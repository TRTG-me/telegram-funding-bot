import { Markup } from 'telegraf';
import { bot } from './core/bot';

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
import { SummaryController } from './modules/summary/summary.controller'
import { SummaryService } from './modules/summary/summary.service';
import { TotalPositionsController } from './modules/totalPositions/totalPositions.controller';
import { TotalPositionsService } from './modules/totalPositions/totalPositions.service';


import { message } from 'telegraf/filters';

// --- ИЗМЕНЕНО: Добавляем новую строку с кнопками для уведомлений ---
const mainMenuKeyboard = Markup.keyboard([

    ['✏️ Изменить ранги', 'Плечи и Эквити'],
    ['📊 Сверка Позиций']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // --- Инициализация всех сервисов и контроллеров ---
    const hyperliquidService = new HyperliquidService();
    const hyperliquidController = new HyperliquidController(hyperliquidService, userState);

    const binanceService = new BinanceService();
    const binanceController = new BinanceController(binanceService, userState);

    const paradexService = new ParadexService();
    const paradexController = new ParadexController(paradexService, userState);

    const lighterService = new LighterService();
    const lighterController = new LighterController(lighterService, userState);

    const notificationService = new NotificationService(bot);
    const notificationController = new NotificationController(notificationService);

    const extendedService = new ExtendedService();
    const extendedController = new ExtendedController(extendedService, userState);

    const rankingService = new RankingService();
    const rankingController = new RankingController(rankingService, userState);

    const totalPositionsService = new TotalPositionsService(
        binanceService,
        hyperliquidService,
        paradexService,
        lighterService,
        extendedService
    );
    // Затем создаем контроллер, передав ему только что созданный сервис
    const totalPositionsController = new TotalPositionsController(totalPositionsService);

    const summaryService = new SummaryService(
        binanceService,
        hyperliquidService,
        paradexService,
        lighterService,
        extendedService
    );
    const summaryController = new SummaryController(summaryService);

    // --- Регистрация команды /start ---
    bot.start((ctx) => {
        // При старте на всякий случай сбрасываем состояние
        userState.delete(ctx.from.id);
        ctx.reply(
            'Привет! Используйте меню внизу.',
            mainMenuKeyboard
        );
    });

    // --- Общий обработчик-маршрутизатор для всех текстовых сообщений ---
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from.id;
        const text = ctx.message.text;
        const currentState = userState.get(userId);

        // --- ИЗМЕНЕНО: Добавляем названия новых кнопок в проверку ---
        const mainMenuCommands = ['🔎 HL', '✖️ Калькулятор', 'BIN', 'Paradex', 'Lighter', '🔔 Включить Alert', '🔕 Выключить Alert', 'Extended', '✏️ Изменить ранги', 'Плечи и Эквити', '📊 Сверка Позиций'];

        if (mainMenuCommands.includes(text)) {
            userState.delete(userId); // Сбрасываем предыдущее состояние!

            switch (text) {
                case '🔎 HL':
                    hyperliquidController.onWalletAddressReceived(ctx, mainMenuKeyboard);
                    return;



                case 'BIN':
                    binanceController.onEquityRequest(ctx, mainMenuKeyboard);
                    return;
                case 'Paradex':
                    paradexController.onAccountRequest(ctx, mainMenuKeyboard);
                    return;

                case 'Lighter':
                    lighterController.onAccountRequestL(ctx, mainMenuKeyboard);
                    return;

                case 'Extended':
                    extendedController.onAccountRequest(ctx, mainMenuKeyboard);
                    return;

                case '🔔 Включить Alert':
                    notificationController.startMonitoring(ctx);
                    return;

                case '🔕 Выключить Alert':
                    notificationController.stopMonitoring(ctx);
                    return;

                case '✏️ Изменить ранги':
                    return rankingController.onUpdateRanksRequest(ctx);

                case 'Плечи и Эквити':
                    return summaryController.sendSummaryTable(ctx);

                case '📊 Сверка Позиций':
                    return totalPositionsController.displayAggregatedPositions(ctx);

            }
        }

        // Если это не команда из меню, тогда проверяем состояние
        // if (currentState === 'awaiting_wallet_address') {
        //     hyperliquidController.onWalletAddressReceived(ctx, mainMenuKeyboard);
        //     return;
        // }

        if (currentState === 'awaiting_ranks_json') { // Новое состояние
            return rankingController.onRanksJsonReceived(ctx);
        }

        // Если мы дошли до сюда, значит, это неизвестная команда
        ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
    });

    // --- Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен с модулем уведомлений!');
}

start();