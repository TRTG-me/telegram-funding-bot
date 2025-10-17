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


import { message } from 'telegraf/filters';

const mainMenuKeyboard = Markup.keyboard([
    ['🔎 HL', '✖️ Калькулятор'],
    ['BIN', 'Paradex', 'Lighter']
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

        // --- ИЗМЕНЕНИЕ ЛОГИКИ ---
        // Сначала проверяем, не является ли сообщение командой из главного меню.
        // Это позволяет "перебить" любое предыдущее состояние.
        if (text === '🔎 HL' || text === '✖️ Калькулятор' || text === 'BIN' || text === 'Paradex' || text === 'Lighter') {
            userState.delete(userId); // Сбрасываем предыдущее состояние!

            switch (text) {
                case '🔎 HL':
                    hyperliquidController.onCheckAccountRequest(ctx, mainMenuKeyboard);
                    return; // Выходим

                case '✖️ Калькулятор':
                    // ИСПРАВЛЕНИЕ: Теперь мы передаем клавиатуру
                    calculatorController.onMultiplyRequest(ctx, mainMenuKeyboard);
                    return; // Выходим

                case 'BIN':
                    // Передаем клавиатуру в метод контроллера
                    binanceController.onEquityRequest(ctx, mainMenuKeyboard);
                    return;
                case 'Paradex':
                    // Передаем клавиатуру в метод контроллера
                    paradexController.onAccountRequest(ctx, mainMenuKeyboard);
                    return;

                case 'Lighter':
                    lighterController.onAccountRequestPara(ctx, mainMenuKeyboard);
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
    console.log('Бот успешно запущен с исправленной логикой!');
}

start();