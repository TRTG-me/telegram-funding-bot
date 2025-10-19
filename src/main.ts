import { Markup } from 'telegraf';
import { bot } from './core/bot';

import { HyperliquidController } from './modules/hyperliquid/hyperliquid.controller';
import { HyperliquidService } from './modules/hyperliquid/hyperliquid.service';
import { CalculatorController } from './modules/calculator/calculator.controller';
import { CalculatorService } from './modules/calculator/calculator.service';
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


import { message } from 'telegraf/filters';

// --- ИЗМЕНЕНО: Добавляем новую строку с кнопками для уведомлений ---
const mainMenuKeyboard = Markup.keyboard([
    ['🔎 HL', '✖️ Калькулятор', 'Extended'],
    ['BIN', 'Paradex', 'Lighter'],
    ['🔔 Включить Alert', '🔕 Выключить Alert']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // --- Инициализация всех сервисов и контроллеров ---
    const hyperliquidService = new HyperliquidService();
    const hyperliquidController = new HyperliquidController(hyperliquidService, userState);

    const calculatorService = new CalculatorService();
    const calculatorController = new CalculatorController(calculatorService, userState);

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
        const mainMenuCommands = ['🔎 HL', '✖️ Калькулятор', 'BIN', 'Paradex', 'Lighter', '🔔 Включить Alert', '🔕 Выключить Alert', 'Extended'];

        if (mainMenuCommands.includes(text)) {
            userState.delete(userId); // Сбрасываем предыдущее состояние!

            switch (text) {
                case '🔎 HL':
                    hyperliquidController.onCheckAccountRequest(ctx, mainMenuKeyboard);
                    return;

                case '✖️ Калькулятор':
                    calculatorController.onMultiplyRequest(ctx, mainMenuKeyboard);
                    return;

                case 'BIN':
                    binanceController.onEquityRequest(ctx, mainMenuKeyboard);
                    return;
                case 'Paradex':
                    paradexController.onAccountRequest(ctx, mainMenuKeyboard);
                    return;

                case 'Lighter':
                    lighterController.onAccountRequestPara(ctx, mainMenuKeyboard);
                    return;

                case 'Extended':
                    extendedController.onPositionsRequest(ctx, mainMenuKeyboard);
                    return;

                case '🔔 Включить Alert':
                    notificationController.startMonitoring(ctx);
                    return;

                case '🔕 Выключить Alert':
                    notificationController.stopMonitoring(ctx);
                    return;
            }
        }

        // Если это не команда из меню, тогда проверяем состояние
        if (currentState === 'awaiting_wallet_address') {
            hyperliquidController.onWalletAddressReceived(ctx, mainMenuKeyboard);
            return;
        }
        if (currentState === 'awaiting_multiplication_numbers') {
            calculatorController.onNumbersReceived(ctx, mainMenuKeyboard);
            return;
        }


        // Если мы дошли до сюда, значит, это неизвестная команда
        ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
    });

    // --- Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен с модулем уведомлений!');
}

start();